import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { roles, specialistIds, runModes, roleForMode } from './lib/roles.mjs';
import { defaultSettings, validateSettings } from './lib/settings.mjs';
import { resolveMode } from './projects.mjs';
import { taskPrompt } from './lib/prompts.mjs';
import { prepareSkillApplication } from './lib/skills.mjs';
import { validateDispatch, dispatchInstruction } from './lib/dispatch.mjs';
import { makeContinuation, ContinuationError } from './lib/continuation.mjs';
import { validateRequestContext, RequestContextError } from './lib/request-context.mjs';
import { cliRunner, findCodex, validateResult } from './lib/codex-runner.mjs';
import { saveAttachments, readAttachment } from './lib/attachments.mjs';
import {
  inspectSkillDrafts,
  publishSkillDrafts,
  skillDraftSnapshot,
} from './lib/project-skill-drafts.mjs';
import {
  MAX_ESCALATIONS,
  safeErrorMessage,
  incidentEvidence,
  isPermissionBlock,
} from './lib/escalation.mjs';

export { roles, cliRunner, findCodex, validateResult, ContinuationError, RequestContextError };

export class AcceptanceError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function legacyRolesForRun(run) {
  return defaultSettings().agents.map((role) => ({
    ...role,
    model: run.agents?.[role.id]?.model || roleForMode(role, run.mode).model,
    effort: run.agents?.[role.id]?.effort || roleForMode(role, run.mode).effort,
    provider: 'codex',
  }));
}

export class Office {
  constructor({ dataDir, workspaceRoot, runtime, runner, hostServices, getSettings }) {
    this.dataDir = dataDir;
    this.workspaceRoot = workspaceRoot;
    this.runtime = runtime;
    this.runner = runner || cliRunner(runtime);
    this.hostServices = hostServices;
    this.getSettings = getSettings || defaultSettings;
    this.listeners = new Set();
    this.controllers = new Map();
    this.runs = [];
    mkdirSync(dataDir, { recursive: true });
    const file = join(dataDir, 'state.json');
    if (existsSync(file)) {
      this.runs = JSON.parse(readFileSync(file, 'utf8')).runs || [];
      for (const r of this.runs) {
        if (!Array.isArray(r.roles)) r.roles = legacyRolesForRun(r);
        if (r.environment?.preview?.status === 'ready')
          r.environment.preview = {
            status: 'unavailable',
            reason: 'アプリ再起動後、次の実行時にプレビューを再準備します。',
          };
      }
      for (const r of this.runs)
        if (['running', 'queued'].includes(r.status)) {
          r.status = 'needs_attention';
          r.error =
            'アプリが再起動しました。前の作業の変更内容を確認して新しい依頼を開始してください。';
          for (const a of Object.values(r.agents)) if (a.status === 'working') a.status = 'blocked';
          for (const task of r.tasks || [])
            if (task.status === 'working') {
              task.status = 'blocked';
              task.error = 'アプリ再起動により実行の完了を確認できません';
              task.finishedAt = new Date().toISOString();
            }
          if (
            r.escalation &&
            ['consulting', 'instructed', 'retrying'].includes(r.escalation.status)
          ) {
            r.escalation.status = 'awaiting_user';
            const last = r.escalations?.at(-1);
            if (last) last.status = 'awaiting_user';
          }
        }
    }
    this.persist();
  }
  state() {
    return {
      runs: this.runs,
      activeRunId: this.runs.find((r) => ['running', 'queued'].includes(r.status))?.id || null,
      roles: validateSettings(this.getSettings()).agents,
      supportedModes: runModes,
      capabilities: {
        continuation: true,
        automaticDispatch: true,
        taskHistory: true,
        projectSetup: true,
      },
      runtime: { available: this.runtime.available, version: this.runtime.version },
      workspaceRoot: this.workspaceRoot,
    };
  }
  persist() {
    const file = join(this.dataDir, 'state.json');
    writeFileSync(file + '.tmp', JSON.stringify({ runs: this.runs }, null, 2), { mode: 0o600 });
    renameSync(file + '.tmp', file);
    for (const fn of this.listeners) fn(this.state());
  }
  event(run, role, type, message, taskId = null) {
    run.updatedAt = new Date().toISOString();
    run.events.push({ at: run.updatedAt, role, type, message, taskId });
    if (taskId) {
      const task = run.tasks?.find((item) => item.id === taskId);
      if (task) {
        task.lastActivity = message;
        task.lastEventAt = run.updatedAt;
      }
    }
    run.events = run.events.slice(-400);
    this.persist();
  }
  start({
    kind,
    instruction,
    workspace,
    mode,
    specialists,
    project,
    continueFromRunId,
    requestContext,
    attachments,
  }) {
    if (this.runs.some((r) => ['running', 'queued'].includes(r.status)))
      throw Error('実行中の依頼が終わるか停止してから開始してください');
    let continuation = null;
    let preparationBaseline;
    if (continueFromRunId !== undefined) {
      const source = this.runs.find((r) => r.id === continueFromRunId);
      if (!source) throw new ContinuationError(404, '継続元の依頼が見つかりません');
      continuation = makeContinuation(source, {
        instruction,
        workspace,
        mode,
        specialists,
        project,
      });
      if (requestContext !== undefined) {
        const supplied = validateRequestContext(requestContext);
        if (JSON.stringify(supplied) !== JSON.stringify(source.requestContext ?? null))
          throw new RequestContextError('継続時に元の依頼の文脈を変更できません');
      }
      requestContext = source.requestContext ?? null;
      if (kind !== undefined && kind !== (source.kind || 'ordinary'))
        throw new ContinuationError(400, '継続時に依頼の種類は変更できません');
      kind = source.kind || 'ordinary';
      preparationBaseline = source.preparationBaseline;
      ({ instruction, workspace, mode, specialists, project } = continuation);
    }
    const checkedRequestContext =
      requestContext === null && continuation ? null : validateRequestContext(requestContext);
    kind ??= 'ordinary';
    if (!['ordinary', 'project-setup'].includes(kind)) throw Error('依頼の種類が不正です');
    const settings = validateSettings(this.getSettings());
    const selectionMode = specialists === undefined ? 'auto' : 'manual';
    if (specialists === undefined) specialists = [];
    project ??= null;
    mode = resolveMode(mode);
    if (
      !Array.isArray(specialists) ||
      specialists.some((id) => !specialistIds.includes(id)) ||
      new Set(specialists).size !== specialists.length
    )
      throw Error('担当の選択が正しくありません');
    if (
      project !== null &&
      (!project ||
        typeof project !== 'object' ||
        !['id', 'label', 'path'].every(
          (key) => typeof project[key] === 'string' && project[key].trim(),
        ))
    )
      throw Error('プロジェクト情報が正しくありません');
    const chosen = settings.agents.map((role) =>
      role.useModeDefaults && role.provider === 'codex' && roles.some((r) => r.id === role.id)
        ? roleForMode(role, mode)
        : { ...role },
    );
    const selected = [...specialists];
    if (selected.some((id) => !chosen.find((role) => role.id === id)?.enabled))
      throw Error('無効な担当は選択できません');
    const run = {
      kind,
      id: randomUUID(),
      instruction,
      rootInstruction: continuation?.rootInstruction ?? instruction,
      requestContext: checkedRequestContext,
      userAdditions: continuation?.userAdditions ?? [],
      continueFromRunId: continuation?.continueFromRunId ?? null,
      priorResults: continuation?.priorResults ?? {},
      priorRun: continuation?.priorRun ?? null,
      workspace,
      mode,
      project: project ? { id: project.id, label: project.label, path: project.path } : null,
      specialists: selected,
      selectionMode,
      dispatch: null,
      tasks: [],
      roles: chosen,
      skillSnapshot: {
        version: 1,
        capturedAt: new Date().toISOString(),
        definitions: structuredClone(settings.skills),
      },
      status: 'queued',
      stage: 'commander',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      round: 0,
      agents: Object.fromEntries(
        chosen.map((r) => [
          r.id,
          {
            status:
              !r.enabled ||
              (selectionMode === 'auto'
                ? r.id !== 'commander'
                : specialistIds.includes(r.id) && !selected.includes(r.id))
                ? 'skipped'
                : 'idle',
            summary:
              !r.enabled ||
              (selectionMode === 'auto'
                ? r.id !== 'commander'
                : specialistIds.includes(r.id) && !selected.includes(r.id))
                ? '今回は担当しません'
                : '次の依頼を待っています',
            output: '',
            model: r.model,
            effort: r.effort,
            provider: r.provider,
          },
        ]),
      ),
      events: [],
      escalations: [],
      escalation: null,
      error: null,
    };
    if (preparationBaseline) run.preparationBaseline = preparationBaseline;
    if (kind === 'project-setup' && !preparationBaseline) {
      const file = join(workspace, 'AGENTS.md');
      try {
        if (!lstatSync(file).isFile()) throw Error('通常ファイルではありません');
        const original = readFileSync(file);
        const backup = join('preparation-backups', run.id, 'AGENTS.md');
        mkdirSync(join(this.dataDir, 'preparation-backups', run.id), {
          recursive: true,
          mode: 0o700,
        });
        writeFileSync(join(this.dataDir, backup), original, { flag: 'wx', mode: 0o600 });
        run.preparationBaseline = {
          bytes: original.length,
          sha256: createHash('sha256').update(original).digest('hex'),
          backup,
        };
      } catch (error) {
        if (error.code !== 'ENOENT')
          throw new AcceptanceError(
            400,
            '既存AGENTS.mdを安全に保存できません。ファイルと権限を確認してください',
          );
      }
    }
    run.attachments = saveAttachments(
      this.dataDir,
      run.id,
      attachments,
      continuation ? this.runs.find((r) => r.id === continueFromRunId)?.attachments || [] : [],
    );
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    this.runs.unshift(run);
    if (this.runs.length > 30) {
      const archived = this.runs.splice(30);
      mkdirSync(join(this.dataDir, 'archive'), { recursive: true });
      for (const old of archived)
        writeFileSync(
          join(this.dataDir, 'archive', old.id + '.json'),
          JSON.stringify(old, null, 2),
          { mode: 0o600 },
        );
    }
    this.event(run, 'commander', 'created', '依頼を受け付けました');
    run.promise = this.execute(run, chosen, controller).finally(async () => {
      if (this.hostServices) {
        try {
          run.environment ||= {};
          run.environment.worklog = await this.hostServices.finish(run);
        } catch {
          run.environment ||= {};
          run.environment.worklog = {
            status: 'failed',
            reason: 'アプリ本体で共通ログを保存できませんでした。',
          };
        }
        if (run.status === 'completed' && run.environment.worklog?.status === 'failed')
          this.attention(
            run,
            '成果の最終確認は通りましたが、共通ログの保存に失敗しました。アプリの保存先を確認してください。',
          );
      }
      delete run.promise;
      this.controllers.delete(run.id);
      this.persist();
    });
    return run;
  }
  cancel(id) {
    const c = this.controllers.get(id);
    if (!c) return false;
    c.abort();
    const r = this.runs.find((r) => r.id === id);
    if (r?.escalation && ['consulting', 'instructed', 'retrying'].includes(r.escalation.status))
      this.setEscalation(r, r.escalations.at(-1), 'cancelled');
    this.event(r, 'commander', 'stopping', '停止を要求しました。作成済みのファイルは残ります。');
    return true;
  }
  accept(id) {
    const run = this.runs.find((entry) => entry.id === id);
    if (!run) throw new AcceptanceError(404, '依頼が見つかりません');
    if (run.status !== 'completed')
      throw new AcceptanceError(409, '完了した依頼だけを受け入れできます');
    if (run.acceptance?.status === 'accepted') return run.acceptance;
    run.acceptance = { status: 'accepted', acceptedAt: new Date().toISOString() };
    this.event(run, 'commander', 'accepted', 'ユーザーが成果を受け入れました');
    return run.acceptance;
  }
  async task(run, all, id, instruction, context, signal, options = {}) {
    if (signal.aborted) throw Error('実行を停止しました');
    await this.prepareEnvironment(run);
    if (signal.aborted) throw Error('実行を停止しました');
    const role = all.find((r) => r.id === id),
      agent = run.agents[id];
    Object.assign(agent, {
      status: 'working',
      summary: instruction,
      assignment: instruction,
      activity: '担当を起動しています',
      attempt: (agent.attempt || 0) + 1,
      progress: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      usage: null,
    });
    const task = {
      id: randomUUID(),
      roleId: id,
      instruction,
      promptInstruction: options.promptInstruction || instruction,
      round: run.round,
      attempt: agent.attempt,
      inputRefs: this.contextRefs(run, context),
      reason: run.dispatch?.assignments.find((entry) => entry.roleId === id)?.reason || '',
      status: 'working',
      startedAt: agent.startedAt,
      finishedAt: null,
      model: role.model,
      effort: role.effort,
      provider: role.provider,
      skillApplication: { status: 'pending', entries: [] },
    };
    (run.tasks ||= []).push(task);
    run.stage = id;
    this.event(run, id, 'started', instruction, task.id);
    let usageRecorded = false;
    try {
      if (run.kind === 'project-setup' && role.stage === 'review') {
        task.preparationDrafts = skillDraftSnapshot(inspectSkillDrafts(run.workspace));
        if (task.preparationDrafts.length)
          task.promptInstruction += `\n配置対象のSkill草案を全件レビューしてください。.office-preparation/skills/<name>/SKILL.md の内容と元の依頼・採否理由を確認し、未確認の草案を合格にしないでください。verificationに草案ごとのstatus=verified、subject=.office-preparation/skills/<name>/SKILL.md、evidence=内容ハッシュと確認した根拠を記載してください。対象名と内容ハッシュ: ${JSON.stringify(task.preparationDrafts)}`;
      }
      const application = prepareSkillApplication(run, role);
      task.skillApplication = { status: application.status, entries: application.entries };
      const prompt = taskPrompt({
        run,
        role,
        id,
        instruction: task.promptInstruction,
        context,
        promptSkills: application.promptSkills,
        attachmentTexts: (run.attachments || [])
          .filter((item) => item.kind === 'text')
          .map((item) => ({
            name: item.name,
            text: readAttachment(this.dataDir, item).bytes.toString('utf8'),
          })),
      });
      this.persist();
      const result = validateResult(
        await this.runner({
          run,
          role,
          prompt,
          imagePaths: (run.attachments || [])
            .filter((item) => item.kind === 'image')
            .map((item) => readAttachment(this.dataDir, item).path),
          signal,
          schemaFile: options.schemaFile,
          onEvent: (msg, progress) => {
            agent.activity = msg;
            if (progress) agent.progress = progress;
            this.event(run, id, 'activity', msg, task.id);
          },
          onUsage: (measured) => {
            if (usageRecorded) return;
            usageRecorded = true;
            agent.usage = measured;
            run.tokenUsage ||= { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
            for (const key of Object.keys(run.tokenUsage))
              run.tokenUsage[key] += measured[key] || 0;
          },
        }),
      );
      if (signal.aborted) throw Error('実行を停止しました');
      Object.assign(agent, {
        status: result.verdict === 'blocked' ? 'blocked' : 'done',
        summary: result.summary,
        output: result.content,
        result,
        finishedAt: new Date().toISOString(),
      });
      Object.assign(task, {
        status: agent.status,
        result,
        finishedAt: agent.finishedAt,
        usage: agent.usage,
      });
      this.event(run, id, 'finished', result.summary, task.id);
      return result;
    } catch (e) {
      agent.status = 'blocked';
      agent.summary = safeErrorMessage(e);
      agent.finishedAt = new Date().toISOString();
      Object.assign(task, {
        status: 'blocked',
        error: agent.summary,
        finishedAt: agent.finishedAt,
      });
      if (task.skillApplication?.status === 'pending')
        task.skillApplication = { status: 'error', entries: [] };
      this.event(run, id, 'error', agent.summary, task.id);
      throw e;
    }
  }
  contextRefs(run, context) {
    const byResult = new Map(
      (run.tasks || []).filter((task) => task.result).map((task) => [task.result, task.id]),
    );
    const refs = new Set();
    const seen = new Set();
    const visit = (value) => {
      if (!value || typeof value !== 'object' || seen.has(value)) return;
      seen.add(value);
      const id = byResult.get(value);
      if (id) {
        refs.add(id);
        return;
      }
      for (const child of Object.values(value)) visit(child);
    };
    visit(context);
    return [...refs].map((taskId) => ({ runId: run.id, taskId }));
  }
  async prepareEnvironment(run) {
    if (!this.hostServices) return;
    try {
      run.environment = await this.hostServices.prepare(run);
    } catch {
      run.environment = {
        preview: { status: 'unavailable', reason: 'アプリ側の確認環境を準備できませんでした。' },
        worklog: { status: 'failed', reason: '保存状態を確認できませんでした。' },
      };
    }
    this.persist();
  }
  setEscalation(run, entry, status, fields = {}) {
    Object.assign(entry, fields, { status, updatedAt: new Date().toISOString() });
    run.escalation = { ...entry };
    this.event(run, 'commander', 'escalation', `${entry.sourceRole}: ${status}`);
  }
  commanderAttention(run, result, phase) {
    const now = new Date().toISOString();
    const entry = {
      sourceRole: 'commander',
      consultingRoleId: 'commander',
      reason: result.summary,
      sourceEvidence: incidentEvidence(result),
      status: 'awaiting_user',
      decision: result.verdict,
      result,
      attempt: run.escalations.filter((incident) => incident.consulted).length,
      consulted: false,
      phase,
      createdAt: now,
      updatedAt: now,
    };
    run.escalations.push(entry);
    this.setEscalation(run, entry, 'awaiting_user');
    this.attention(run, result.summary);
  }
  async consultCommander(run, all, sourceRole, result, error, context, signal) {
    if (signal.aborted) throw Error('実行を停止しました');
    const reason = result?.summary || safeErrorMessage(error);
    const consulted = run.escalations.filter((incident) => incident.consulted).length;
    const entry = {
      sourceRole,
      consultingRoleId: 'commander',
      reason,
      sourceEvidence: incidentEvidence(result, error),
      status: consulted >= MAX_ESCALATIONS ? 'exhausted' : 'consulting',
      decision: null,
      result: null,
      attempt: consulted >= MAX_ESCALATIONS ? consulted : consulted + 1,
      consulted: consulted < MAX_ESCALATIONS,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    run.escalations.push(entry);
    this.setEscalation(run, entry, entry.status);
    if (!entry.consulted) {
      this.attention(
        run,
        '指揮官への相談上限に達しました。最後の障害と作業結果を確認してください。',
      );
      return null;
    }
    let decision;
    try {
      decision = await this.task(
        run,
        all,
        'commander',
        '障害対応: 元の依頼と既存成果を確認し、該当担当が現行権限内で実行できる具体的な解決指示を出してください。これは最終合格判定ではありません。権限・承認・外部状態が必要ならblockedまたはreviseで人の対応を求めてください。',
        {
          incident: { sourceRole, reason, sourceEvidence: entry.sourceEvidence },
          completedStages: context,
          permissions: {
            builder: 'workspace-write',
            others: 'read-only',
            approval: 'never',
            bypass: false,
          },
        },
        signal,
      );
    } catch (e) {
      if (signal.aborted) {
        this.setEscalation(run, entry, 'cancelled');
        throw e;
      }
      this.setEscalation(run, entry, 'failed', { reason: safeErrorMessage(e) });
      this.attention(
        run,
        '指揮官が障害を診断できませんでした。作業結果と実行環境を確認してください。',
      );
      return null;
    }
    if (decision.verdict !== 'pass' || !decision.content.trim()) {
      this.setEscalation(run, entry, 'awaiting_user', {
        decision: decision.verdict,
        result: decision,
      });
      this.attention(
        run,
        decision.summary || '人の対応が必要です。指揮官の診断を確認してください。',
      );
      return null;
    }
    this.setEscalation(run, entry, 'instructed', { decision: 'pass', result: decision });
    return entry;
  }
  async stageWithEscalation(run, all, id, instruction, context, signal, options = {}) {
    let firstOutcome = options.firstOutcome;
    let currentInstruction = instruction;
    let currentContext = context;
    for (;;) {
      if (signal.aborted) throw Error('実行を停止しました');
      let result, error;
      if (firstOutcome) {
        ({ result, error } = firstOutcome);
        firstOutcome = null;
      } else {
        try {
          result = await this.task(run, all, id, currentInstruction, currentContext, signal);
        } catch (e) {
          if (signal.aborted) throw e;
          error = e;
        }
      }
      if (result?.verdict === 'pass' || (result?.verdict === 'revise' && !options.preparation)) {
        if (currentContext !== context && run.escalation?.status === 'retrying')
          this.setEscalation(run, run.escalations.at(-1), 'resolved');
        return result;
      }
      const entry = await this.consultCommander(
        run,
        all,
        id,
        result,
        error,
        currentContext,
        signal,
      );
      if (!entry) return null;
      if (!options.preparation && isPermissionBlock(result)) {
        this.setEscalation(run, entry, 'awaiting_user');
        this.attention(run, '権限・承認が必要な障害です。必要な対応を確認してください。');
        return null;
      }
      if (options.allowBlockedEvidence && result?.verdict === 'blocked') {
        this.setEscalation(run, entry, 'resolved');
        return { ...result, escalationInstruction: entry.result.content };
      }
      if (error?.code === 'OFFICE_LOOP_GUARD') {
        this.setEscalation(run, entry, 'awaiting_user');
        this.attention(run, '同じ操作の失敗を繰り返さないため、人が実行条件を確認してください。');
        return null;
      }
      this.setEscalation(run, entry, 'retrying');
      currentInstruction = `${instruction}\n指揮官の障害対応指示: ${entry.result.content}`;
      currentContext = {
        ...context,
        incident: {
          sourceEvidence: entry.sourceEvidence,
          commanderInstruction: entry.result.content,
        },
      };
    }
  }
  async executeAutomatic(run, all, signal) {
    const brief = await this.task(
      run,
      all,
      'commander',
      '依頼を整理し、必要な担当と進め方を決めてください。',
      {},
      signal,
      { schemaFile: 'dispatch.schema.json', promptInstruction: dispatchInstruction(all) },
    );
    if (brief.verdict !== 'pass') return this.commanderAttention(run, brief, 'brief');
    try {
      run.dispatch = validateDispatch(brief.dispatch, all);
    } catch (error) {
      this.attention(run, error.message);
      return;
    }
    const chosen = new Set(run.dispatch.assignments.map((entry) => entry.roleId));
    run.specialists = specialistIds.filter((id) => chosen.has(id));
    for (const role of all) {
      if (role.id === 'commander') continue;
      Object.assign(run.agents[role.id], {
        status: chosen.has(role.id) ? 'idle' : 'skipped',
        summary: chosen.has(role.id)
          ? '社長の依頼を待っています'
          : '社長が今回の依頼では不要と判断しました',
      });
    }
    this.event(run, 'commander', 'dispatch', run.dispatch.summary);
    if (!chosen.size) {
      if (!this.verifyPreparation(run)) return;
      run.status = 'completed';
      this.event(run, 'commander', 'completed', brief.summary);
      return;
    }
    const preparation = { brief, dispatch: run.dispatch, results: {} };
    const selected = run.dispatch.assignments;
    for (const entry of selected.filter(
      ({ roleId }) => roleId !== 'builder' && all.find((r) => r.id === roleId).stage !== 'review',
    )) {
      const result = await this.stageWithEscalation(
        run,
        all,
        entry.roleId,
        entry.instruction,
        preparation,
        signal,
        { preparation: true },
      );
      if (!result) return;
      preparation.results[entry.roleId] = result;
    }
    const builder = selected.find(({ roleId }) => roleId === 'builder');
    const reviewers = selected.filter(
      ({ roleId }) => roleId !== 'builder' && all.find((r) => r.id === roleId).stage === 'review',
    );
    let feedback = null;
    for (let round = 1; round <= (builder ? 3 : 1); round++) {
      run.round = round;
      if (round > 1) {
        for (const entry of reviewers)
          Object.assign(run.agents[entry.roleId], {
            status: 'idle',
            summary: '再実装後の確認を待っています',
            output: '',
            result: null,
            startedAt: null,
            finishedAt: null,
          });
        this.persist();
      }
      let implementation = null;
      if (builder) {
        implementation = await this.stageWithEscalation(
          run,
          all,
          'builder',
          builder.instruction + (feedback ? '\n前回の指摘を修正し、確認してください。' : ''),
          { ...preparation, feedback },
          signal,
        );
        if (!implementation) return;
      }
      // All selected reviewers receive the same context, with no peer conclusions.
      const context = { ...preparation, implementation };
      const reviews = {};
      for (const entry of reviewers) {
        const result = await this.stageWithEscalation(
          run,
          all,
          entry.roleId,
          entry.instruction,
          context,
          signal,
        );
        if (!result) return;
        reviews[entry.roleId] = result;
      }
      if (
        implementation?.verdict === 'revise' ||
        Object.values(reviews).some((r) => r.verdict !== 'pass')
      ) {
        feedback = { implementation, reviews };
        if (builder && round < 3) {
          this.event(run, 'commander', 'revision', '選ばれた確認担当の指摘を実装担当へ戻します');
          continue;
        }
        this.attention(run, '選ばれた担当の未解決事項があります。成果を確認してください。');
        return;
      }
      const final = await this.task(
        run,
        all,
        'commander',
        '元の依頼と完了条件を、選定担当の成果・検証の証拠と照合して最終回答してください。未実施の確認は明示し、未達の条件は合格にしないでください。',
        { ...context, reviews },
        signal,
      );
      if (final.verdict === 'pass') {
        if (!this.verifyPreparation(run)) return;
        run.status = 'completed';
        this.event(run, 'commander', 'completed', final.summary);
        return;
      }
      if (final.verdict === 'revise' && builder && round < 3) {
        feedback = { implementation, reviews, final };
        this.event(run, 'commander', 'revision', '社長の指摘を選定した実装担当へ戻します');
        continue;
      }
      return this.commanderAttention(run, final, 'final');
    }
  }
  async execute(run, all, controller) {
    const signal = controller.signal;
    let reviewLoopFailure = null;
    try {
      run.status = 'running';
      if (run.selectionMode === 'auto') return await this.executeAutomatic(run, all, signal);
      const brief = await this.task(
        run,
        all,
        'commander',
        '依頼を具体的な目標・完了条件・担当への指示に整理してください。',
        {},
        signal,
      );
      if (brief.verdict !== 'pass') return this.commanderAttention(run, brief, 'brief');
      const preparation = { brief };
      if (run.specialists.includes('researcher')) {
        preparation.research = await this.stageWithEscalation(
          run,
          all,
          'researcher',
          '対象の資料・現状・制約を調査し、根拠と未確認事項を整理してください。',
          preparation,
          signal,
          { preparation: true, allowBlockedEvidence: true },
        );
        if (!preparation.research) return;
      }
      preparation.spec = await this.stageWithEscalation(
        run,
        all,
        'planner',
        '対象を調査し、仕様書・受入条件・実装手順・検証方法を作成してください。',
        preparation,
        signal,
        { preparation: true },
      );
      if (!preparation.spec) return;
      if (run.specialists.includes('architect')) {
        preparation.architecture = await this.stageWithEscalation(
          run,
          all,
          'architect',
          '仕様と既存構成を照合し、実装設計・境界条件・技術リスクを整理してください。',
          preparation,
          signal,
          { preparation: true, allowBlockedEvidence: true },
        );
        if (!preparation.architecture) return;
      }
      if (run.specialists.includes('designer')) {
        preparation.design = await this.stageWithEscalation(
          run,
          all,
          'designer',
          '必要な画面・操作の流れ・アクセシビリティを検討し、実装可能なUI/UX要件を整理してください。',
          preparation,
          signal,
          { preparation: true, allowBlockedEvidence: true },
        );
        if (!preparation.design) return;
      }
      const planningRoles = all.filter(
        (role) => role.id.startsWith('custom_') && role.enabled && role.stage === 'planning',
      );
      if (planningRoles.length) preparation.customPlanning = {};
      for (const role of planningRoles) {
        const result = await this.stageWithEscalation(
          run,
          all,
          role.id,
          'あなたの担当領域について仕様と既存成果を確認し、実装担当への具体的な要件と未解決事項を整理してください。',
          preparation,
          signal,
          { preparation: true },
        );
        if (!result) return;
        preparation.customPlanning[role.id] = result;
      }
      const reviewRoles = all.filter(
        (role) => role.id.startsWith('custom_') && role.enabled && role.stage === 'review',
      );
      let feedback = null;
      let revisionConsultation = null;
      for (let round = 0; ; round++) {
        if (signal.aborted) throw Error('実行を停止しました');
        if (round >= 3) {
          if (revisionConsultation) this.setEscalation(run, revisionConsultation, 'failed');
          const sourceRole = feedback?.qa?.verdict === 'revise' ? 'qa' : 'builder';
          revisionConsultation = await this.consultCommander(
            run,
            all,
            sourceRole,
            {
              verdict: 'revise',
              summary: `${round}回の実装・修正後も未解決の指摘があります。修正方針の判断が必要です。`,
              content: JSON.stringify(feedback),
              issues: [
                '元の依頼の範囲で今修正すべき事項と、将来の実装条件を分け、具体的な担当指示を出してください。完了条件を省略したり、未確認を合格扱いにしないでください。',
              ],
              checks: [],
            },
            null,
            { ...preparation, feedback },
            signal,
          );
          if (!revisionConsultation) return;
          this.setEscalation(run, revisionConsultation, 'retrying');
          feedback = {
            ...feedback,
            commanderInstruction: revisionConsultation.result.content,
          };
        }
        run.round = round + 1;
        if (round) {
          for (const id of ['qa', 'reviewer', 'reviewer2', ...reviewRoles.map((role) => role.id)]) {
            const agent = run.agents[id];
            if (agent.status === 'skipped') continue;
            Object.assign(agent, {
              status: 'idle',
              summary: '再実装後の確認を待っています',
              output: '',
              result: null,
              startedAt: null,
              finishedAt: null,
            });
          }
          this.persist();
        }
        const implementation = await this.stageWithEscalation(
          run,
          all,
          'builder',
          round
            ? '指摘事項を修正して、仕様とテストを再確認してください。'
            : '仕様書に沿って実装し、必要なテストを実行してください。',
          { ...preparation, feedback },
          signal,
        );
        if (!implementation) return;
        let qa = null;
        if (run.specialists.includes('qa')) {
          qa = await this.stageWithEscalation(
            run,
            all,
            'qa',
            '実装と受入条件を照合し、確認できた範囲・未実行のテスト・修正点を報告してください。',
            { ...preparation, implementation },
            signal,
          );
          if (!qa) return;
          if (qa.verdict === 'revise') {
            feedback = { implementation, qa };
            this.event(run, 'commander', 'revision', 'QAの指摘事項を実装担当へ戻します');
            continue;
          }
        }
        // Both reviews receive the same frozen context; neither sees the other's opinion.
        const context = { ...preparation, implementation, ...(qa ? { qa } : {}) };
        const reviewController = new AbortController();
        const stopReviews = () => reviewController.abort();
        signal.addEventListener('abort', stopReviews, { once: true });
        if (signal.aborted) stopReviews();
        let reviews;
        try {
          reviews = await Promise.allSettled(
            ['reviewer', 'reviewer2'].map((id) =>
              this.task(
                run,
                all,
                id,
                id === 'reviewer'
                  ? '仕様と実装・テストを照合し、具体的な不一致をレビューしてください。'
                  : '境界条件・安全性・UIの操作性と見落としを独立レビューしてください。',
                context,
                reviewController.signal,
              ).catch((error) => {
                if (error.code === 'OFFICE_LOOP_GUARD') {
                  reviewLoopFailure ||= error;
                  reviewController.abort();
                }
                throw error;
              }),
            ),
          );
        } finally {
          signal.removeEventListener('abort', stopReviews);
        }
        if (signal.aborted) throw Error('実行を停止しました');
        const pair = [];
        for (let index = 0; index < reviews.length; index++) {
          const id = index === 0 ? 'reviewer' : 'reviewer2';
          const review = reviews[index];
          const result = review.status === 'fulfilled' ? review.value : undefined;
          const error = review.status === 'rejected' ? review.reason : undefined;
          if (reviewLoopFailure && error && error !== reviewLoopFailure) continue;
          if (error || result?.verdict === 'blocked') {
            const recovered = await this.stageWithEscalation(
              run,
              all,
              id,
              id === 'reviewer'
                ? '仕様と実装・テストを照合し、具体的な不一致をレビューしてください。'
                : '境界条件・安全性・UIの操作性と見落としを独立レビューしてください。',
              context,
              signal,
              { firstOutcome: { result, error } },
            );
            if (!recovered) return;
            pair.push(recovered);
          } else pair.push(result);
        }
        if (pair.length !== 2) {
          this.attention(
            run,
            '並列レビューの一方が中断されました。レビュー結果を確認してください。',
          );
          return;
        }
        const customReviews = {};
        if (pair.every((r) => r.verdict === 'pass') && implementation.verdict === 'pass') {
          for (const role of reviewRoles) {
            const result = await this.stageWithEscalation(
              run,
              all,
              role.id,
              'あなたの担当領域について実装と受入条件を独立して確認し、具体的な不一致を報告してください。',
              { ...context, reviews: pair },
              signal,
            );
            if (!result) return;
            customReviews[role.id] = result;
          }
        }
        const customPass = Object.values(customReviews).every(
          (result) => result.verdict === 'pass',
        );
        if (
          pair.every((r) => r.verdict === 'pass') &&
          implementation.verdict === 'pass' &&
          customPass
        ) {
          const unresolvedPreparation = Object.fromEntries(
            Object.entries(preparation).filter(
              ([, value]) => value?.verdict && value.verdict !== 'pass',
            ),
          );
          const final = await this.task(
            run,
            all,
            'commander',
            '元の依頼と完了条件を実装・QA・レビューの証拠と照合し、解決したか最終判定してください。準備工程の未解決事項も確認し、未確認は明示してください。',
            { ...context, reviews: pair, customReviews, unresolvedPreparation },
            signal,
          );
          if (final.verdict === 'pass') {
            if (!this.verifyPreparation(run)) return;
            if (revisionConsultation) this.setEscalation(run, revisionConsultation, 'resolved');
            run.status = 'completed';
            this.event(run, 'commander', 'completed', final.summary);
            return;
          }
          if (final.verdict === 'blocked') return this.commanderAttention(run, final, 'final');
          feedback = { reviews: pair, customReviews, final };
        } else feedback = { implementation, ...(qa ? { qa } : {}), reviews: pair, customReviews };
        this.event(run, 'commander', 'revision', '指摘事項を実装担当へ戻します');
      }
    } catch (e) {
      if (!signal.aborted && (reviewLoopFailure || e.code === 'OFFICE_LOOP_GUARD')) {
        this.attention(run, safeErrorMessage(e));
        return;
      }
      run.status = signal.aborted ? 'cancelled' : 'failed';
      run.error = signal.aborted ? '実行を停止しました' : safeErrorMessage(e);
      this.event(run, 'commander', run.status, run.error);
    }
  }
  verifyPreparation(run) {
    if (run.kind !== 'project-setup') return true;
    try {
      const file = join(run.workspace, 'AGENTS.md');
      if (!lstatSync(file).isFile() || !readFileSync(file, 'utf8').trim()) throw Error();
      const baseline = run.preparationBaseline;
      if (
        baseline &&
        createHash('sha256')
          .update(readFileSync(file).subarray(0, baseline.bytes))
          .digest('hex') !== baseline.sha256
      )
        throw Error(
          `既存AGENTS.mdの置換を検出しました。元の内容はアプリのデータフォルダー内 ${baseline.backup} に保管しています。元の内容を保持して差分を確認してください`,
        );
      const drafts = inspectSkillDrafts(run.workspace);
      const snapshot = JSON.stringify(skillDraftSnapshot(drafts));
      const reviewed = run.tasks.some(
        (task) =>
          task.status === 'done' &&
          task.result?.verdict === 'pass' &&
          JSON.stringify(task.preparationDrafts) === snapshot &&
          skillDraftSnapshot(drafts).every((draft) =>
            task.result.verification?.some(
              (proof) =>
                proof.status === 'verified' &&
                proof.subject === `.office-preparation/skills/${draft.name}/SKILL.md` &&
                proof.evidence.includes(draft.sha256),
            ),
          ) &&
          run.roles.some((role) => role.id === task.roleId && role.stage === 'review'),
      );
      const skills = publishSkillDrafts(run.workspace, drafts, { reviewed });
      run.preparationVerification = { status: 'verified', file: 'AGENTS.md', skills };
      return true;
    } catch (error) {
      run.preparationVerification = { status: 'failed', file: 'AGENTS.md' };
      this.attention(
        run,
        `準備ファイルを確認・配置できません。${error.message || 'AGENTS.mdの作成・保存を確認してください。'}`,
      );
      return false;
    }
  }
  attention(run, message) {
    run.status = 'needs_attention';
    run.error = message;
    this.event(run, 'commander', 'needs_attention', message);
  }
}
