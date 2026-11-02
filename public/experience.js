import { resultEntries } from './workflow.js';
import { verificationGroups } from './verification.js';

export function displayRunStatus(run, connected, runtimeAvailable, stopping) {
  if (!run) return connected && runtimeAvailable ? 'idle' : 'unknown';
  if (!['running', 'queued'].includes(run.status)) return run.status;
  if (!connected || !runtimeAvailable) return 'unknown';
  return stopping ? 'stopping' : run.status;
}

export function stoppingView(view, stopping) {
  if (!stopping) return view;
  return {
    ...view,
    headline: '停止を要求しました · 終了は未確認',
    consulting: false,
    groups: view.groups.map((group) =>
      group.map((item) =>
        item.status === 'active' ? { ...item, status: 'stopped', stateLabel: '停止要求中' } : item,
      ),
    ),
  };
}

export function finalResult(run) {
  if (run?.status !== 'completed') return null;
  return (
    resultEntries(run)
      .filter((task) => task.roleId === 'commander' && task.result?.verdict === 'pass')
      .at(-1)?.result || null
  );
}
export function conversationEntries(run, filter = 'all') {
  if (!run) return [];
  const messages = [
    {
      id: 'input',
      roleId: 'user',
      kind: '元の入力',
      content: run.rootInstruction || run.instruction || '',
      at: run.createdAt,
    },
  ];
  (run.userAdditions || []).forEach((content, index) =>
    messages.push({
      id: `addition-${index}`,
      roleId: 'user',
      kind: '修正・追加の入力',
      content,
      at: null,
    }),
  );
  for (const task of resultEntries(run)) {
    if (task.instruction)
      messages.push({
        id: `${task.id}-request`,
        taskId: task.id,
        roleId: task.roleId,
        kind: '担当への依頼',
        content: task.instruction,
        at: task.startedAt,
      });
    if (task.result || task.error)
      messages.push({
        id: `${task.id}-result`,
        taskId: task.id,
        roleId: task.roleId,
        kind: task.error ? '実行エラー' : '担当からの報告',
        content: task.result?.content || task.result?.summary || task.error,
        at: task.finishedAt,
      });
  }
  return messages.filter(
    (message) => filter === 'all' || message.roleId === 'user' || message.roleId === filter,
  );
}
export async function runServiceOperation(action, mutate, refresh) {
  let failure = null;
  try {
    await mutate(action);
  } catch (error) {
    failure = error;
  }
  await refresh();
  return failure;
}
const node = (tag, content, cls) => {
  const item = document.createElement(tag);
  if (content != null) item.textContent = String(content);
  if (cls) item.className = cls;
  return item;
};
const action = (label, fn, cls = 'secondary-button') => {
  const el = node('button', label, cls);
  el.type = 'button';
  el.addEventListener('click', fn);
  return el;
};
const valueText = (value) => (typeof value === 'string' ? value : JSON.stringify(value, null, 2));
const shortId = (run) => (run?.id ? run.id.slice(0, 8) : '');
const pages = [
  ['office', 'ホーム', '⌂'],
  ['new-task', '新しい依頼', '＋'],
  ['work', '作業詳細', '◌'],
  ['talk', 'トーク・履歴', '☏'],
  ['consultation', '社長に相談', '✦'],
  ['results', '成果と確認', '✓'],
  ['services', '作成したサービス', '◇'],
];

export function createExperience(api) {
  const main = document.querySelector('.main-content');
  const nav = document.querySelector('.rail-nav');
  nav.replaceChildren();
  pages.forEach(([id, label, symbol]) => {
    const link = node('a', `${symbol}　${label}`);
    link.href = `#${id}`;
    link.dataset.pageLink = id;
    nav.append(link);
  });
  const servicesPage = node('section', null, 'experience-panel service-page');
  servicesPage.id = 'services';
  servicesPage.dataset.page = 'services';
  servicesPage.append(
    node('p', 'このMacのサービス', 'eyebrow small'),
    node('h1', '作成したサービス'),
    node('p', '独立したローカルサービスをここから起動して開けます。'),
  );
  const serviceCard = node('article', null, 'service-card');
  const serviceStatus = node('p', '状態を確認中');
  serviceStatus.setAttribute('role', 'status');
  const serviceActions = node('div', null, 'service-actions');
  serviceCard.append(
    node('h2', 'AI情報リーダー'),
    node('p', 'AI関連記事を集めて読む'),
    node('p', 'http://127.0.0.1:4318/'),
    serviceStatus,
    serviceActions,
  );
  servicesPage.append(serviceCard);
  document.querySelector('.main-footer').before(servicesPage);
  let serviceBusy = false;
  async function refreshService() {
    if (serviceBusy) return;
    try {
      const response = await fetch('/api/services', { cache: 'no-store' });
      if (!response.ok) throw new Error('Officeの状態を取得できません');
      const service = (await response.json()).services[0];
      serviceStatus.textContent = `${service.status === 'running' ? '起動中' : service.status === 'stopped' ? '停止' : '確認できません'} · ${service.owned ? 'Office管理' : 'Office管理外'} · 確認 ${new Date(service.checkedAt).toLocaleString('ja-JP')}${service.error ? ` · ${service.error}` : ''}`;
      serviceActions.replaceChildren();
      if (service.status === 'running') {
        const link = node('a', 'AI情報リーダーを開く', 'secondary-button');
        link.href = 'http://127.0.0.1:4318/';
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        serviceActions.append(link);
      }
      const operation = async (action) => {
        serviceBusy = true;
        serviceStatus.textContent = '操作中です';
        serviceActions.querySelectorAll('button').forEach((button) => (button.disabled = true));
        try {
          const error = await runServiceOperation(
            action,
            (value) => api.mutate(`/api/services/ai-reader/${value}`, 'POST', {}),
            refreshServiceAfter,
          );
          if (error)
            serviceStatus.textContent = `操作失敗: ${error.message} · ${serviceStatus.textContent}`;
        } catch (error) {
          serviceStatus.textContent = `確認できません: ${error.message}`;
        } finally {
          serviceBusy = false;
        }
      };
      if (service.status === 'stopped')
        serviceActions.append(action('起動', () => operation('start')));
      if (service.owned) {
        serviceActions.append(
          action('停止', () => operation('stop')),
          action('再起動', () => operation('restart')),
        );
      }
      serviceActions.append(action('状態を再確認', refreshService));
    } catch (error) {
      serviceStatus.textContent = `確認できません: ${error.message}`;
      serviceActions.replaceChildren(action('状態を再確認', refreshService));
    }
  }
  async function refreshServiceAfter() {
    const previous = serviceBusy;
    serviceBusy = false;
    await refreshService();
    serviceBusy = previous;
  }
  const brief = node('section', null, 'request-context');
  brief.setAttribute('aria-label', '現在の依頼');
  document.querySelector('.history-section').before(brief);
  const detail = document.querySelector('.detail-panel');
  main.insertBefore(detail, document.querySelector('.main-footer'));
  detail.dataset.page = 'work';
  document.querySelector('.hero').dataset.page = 'office';
  document.querySelector('.office-section').dataset.page = 'office';
  document.querySelector('#workflow').dataset.page = 'work';
  document.querySelector('#new-task').dataset.page = 'new-task';
  document.querySelector('.results-section').dataset.page = 'results';
  document.querySelector('.results-section').id = 'results';
  document.querySelector('#activity').dataset.page = 'talk';
  document.querySelector('#ceo-consultation').dataset.page = 'consultation';
  const status = node('section', null, 'live-status-card');
  status.dataset.page = 'office';
  document.querySelector('.office-section').before(status);
  const work = node('section', null, 'experience-panel');
  work.id = 'work';
  work.dataset.page = 'work';
  work.append(
    node('p', '現在の依頼', 'eyebrow small'),
    node('h1', '作業と担当'),
    node('p', '選ばれた担当の工程と理由、実際の作業を確認できます。'),
  );
  document.querySelector('#workflow').before(work);
  const workLayout = node('div', null, 'work-layout');
  workLayout.dataset.page = 'work';
  const workflow = document.querySelector('#workflow');
  workflow.before(workLayout);
  workLayout.append(workflow, detail);
  const talk = node('section', null, 'experience-panel');
  talk.id = 'talk';
  talk.dataset.page = 'talk';
  talk.append(
    node('p', '入力と報告', 'eyebrow small'),
    node('h1', 'トーク・履歴'),
    node('p', '元の入力から担当の報告まで、記録された順に確認できます。'),
  );
  const filterLabel = node('label', '表示する担当');
  filterLabel.htmlFor = 'talk-filter';
  const filter = node('select');
  filter.id = 'talk-filter';
  filterLabel.append(filter);
  talk.append(filterLabel);
  const messages = node('div', null, 'talk-messages');
  messages.setAttribute('aria-live', 'polite');
  talk.append(messages);
  document.querySelector('#activity').before(talk);
  const final = node('section', null, 'final-result-card');
  document.querySelector('#run-results').before(final);
  const resultFilterLabel = node('label', '担当別の結果');
  resultFilterLabel.htmlFor = 'result-filter';
  const resultFilter = node('select');
  resultFilter.id = 'result-filter';
  resultFilterLabel.append(resultFilter);
  final.after(resultFilterLabel);
  const emptyConsult = node('section', null, 'experience-panel');
  emptyConsult.dataset.page = 'consultation';
  emptyConsult.append(node('h1', '相談'), node('p', '選択中の依頼に相談の記録はありません。'));
  document.querySelector('#ceo-consultation').after(emptyConsult);
  let talkFilter = 'all',
    resultRole = 'all',
    page = '',
    last = '',
    resultSignature = '',
    talkSignature = '';
  filter.addEventListener('change', () => {
    talkFilter = filter.value;
    talkSignature = '';
    update();
  });
  resultFilter.addEventListener('change', () => {
    resultRole = resultFilter.value;
    applyResultsFilter();
  });
  function navigate(target) {
    if (!pages.some(([id]) => id === target)) target = 'office';
    if (location.hash !== `#${target}`) location.hash = target;
    applyPage(target);
    if (target === 'services') void refreshService();
  }
  function applyPage(target) {
    page = pages.some(([id]) => id === target) ? target : 'office';
    document.body.dataset.page = page;
    main
      .querySelectorAll('[data-page]')
      .forEach((el) => el.toggleAttribute('data-route-hidden', el.dataset.page !== page));
    nav.querySelectorAll('a').forEach((link) => {
      const selected = link.dataset.pageLink === page;
      link.classList.toggle('active', selected);
      if (selected) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    document.querySelector('.topbar>span').textContent = pages.find(([id]) => id === page)[1];
    const heading = [
      ...main.querySelectorAll(`[data-page="${page}"] h1,[data-page="${page}"] h2`),
    ].find((el) => !el.closest('[hidden]'));
    heading?.setAttribute('tabindex', '-1');
    heading?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  window.addEventListener('hashchange', () => {
    if (document.querySelector('.settings-dialog[open]')) return;
    applyPage(location.hash.slice(1));
    if (location.hash === '#services') void refreshService();
  });
  function applyResultsFilter() {
    document
      .querySelectorAll('#run-results .result-role')
      .forEach((el) => (el.hidden = resultRole !== 'all' && el.dataset.roleId !== resultRole));
    let empty = document.querySelector('#result-filter-empty');
    if (!empty) {
      empty = node('p', null, 'results-empty');
      empty.id = 'result-filter-empty';
      document.querySelector('#run-results').before(empty);
    }
    const run = api.run();
    const tasks = resultEntries(run).filter((task) => task.roleId === resultRole);
    empty.hidden = resultRole === 'all' || tasks.length > 0;
    empty.textContent =
      'この担当の結果はまだありません。未選定・開始前・未完了は担当の状態で確認できます。';
  }
  function update() {
    const run = api.run(),
      roles = api.roles(),
      online = api.connected();
    emptyConsult.hidden =
      Boolean(run?.escalation) || ['failed', 'needs_attention'].includes(run?.status);
    const sig = JSON.stringify([
      run?.id,
      run?.rootInstruction,
      run?.instruction,
      run?.userAdditions,
      run?.requestContext,
      run?.status,
      run?.stage,
      run?.escalation,
      run?.acceptance,
      online,
      api.stopping(),
      roles.map((role) => [role.id, api.agentStatus(run, role.id), api.agentMessage(run, role.id)]),
    ]);
    if (last !== sig) {
      last = sig;
      const opened = brief.querySelector('details')?.open;
      brief.replaceChildren(
        node('p', run ? `現在の依頼 / ${shortId(run)}` : '現在の依頼', 'eyebrow small'),
      );
      if (run) {
        brief.append(
          ...(run.project?.label ? [node('strong', run.project.label)] : []),
          node('p', run.rootInstruction || run.instruction, 'brief-input'),
        );
        const details = node('details');
        details.open = Boolean(opened);
        details.append(node('summary', '入力・対象・完了条件'));
        for (const [label, value] of [
          ['元の入力', run.rootInstruction || run.instruction],
          ['今回の追加', (run.userAdditions || []).join('\n')],
          ['ほしい成果', run.requestContext?.outcome],
          ['完了条件', run.requestContext?.done],
          ['作業範囲への希望', run.requestContext?.scope],
          ['対象', run.workspace],
        ]) {
          if (value) details.append(node('h4', label), node('p', value));
        }
        brief.append(
          details,
          node(
            'small',
            `${api.status(displayRunStatus(run, online, true, api.stopping()))} · ${api.role(run.stage).name}`,
          ),
        );
        if (['needs_attention', 'failed'].includes(run.status)) {
          brief.append(
            node('strong', '判断・対応が必要です', 'brief-attention'),
            node(
              'p',
              run.escalation?.result?.summary ||
                run.escalation?.reason ||
                run.error ||
                '相談の記録を確認してください。',
            ),
            action('何を判断するか見る', () => navigate('consultation'), 'text-button'),
          );
        }
      } else brief.append(node('p', '依頼はありません。'));
      const view = api.workflow();
      status.replaceChildren(node('div', null, 'status-copy'));
      status.firstChild.append(
        node(
          'strong',
          api.stopping()
            ? '停止完了を確認しています'
            : run?.status === 'completed'
              ? run.acceptance?.status === 'accepted'
                ? '成果を受け入れました'
                : 'AIの確認完了 · あなたの確認待ち'
              : view.headline || (run ? api.status(run.status) : '依頼を待っています'),
        ),
      );
      const working = roles.filter((role) => api.agentStatus(run, role.id) === 'working');
      status.firstChild.append(
        node(
          'p',
          api.stopping()
            ? '停止を要求しました。処理が終了したとは、まだ判断できません。'
            : !online
              ? '接続を確認できません。現在の作業状況は未確認です。'
              : working.length
                ? working
                    .map((role) => `${role.name}：${api.agentMessage(run, role.id)}`)
                    .join(' ／ ')
                : run
                  ? '現在、作業中の担当はいません。'
                  : '必要な担当は、依頼後に指揮官が選びます。',
        ),
      );
      status.append(
        action(
          run && ['needs_attention', 'failed'].includes(run.status)
            ? '相談を確認する'
            : !online
              ? '接続設定を確認'
              : run
                ? '作業の詳細を見る'
                : '最初の依頼を作る',
          () =>
            !online
              ? document.getElementById('open-settings').click()
              : navigate(
                  run && ['needs_attention', 'failed'].includes(run.status)
                    ? 'consultation'
                    : run
                      ? 'work'
                      : 'new-task',
                ),
        ),
      );
    }
    const roleOptions = JSON.stringify(roles.map((role) => [role.id, role.name, role.title]));
    if (filter.dataset.options !== roleOptions) {
      filter.dataset.options = roleOptions;
      for (const select of [filter, resultFilter]) {
        select.replaceChildren(
          new Option('全体', 'all'),
          ...roles.map((role) => new Option(`${role.name} · ${role.title}`, role.id)),
        );
      }
      filter.value = talkFilter;
      resultFilter.value = resultRole;
    }
    const ts = JSON.stringify([
      run?.id,
      run?.rootInstruction,
      run?.userAdditions,
      run?.tasks,
      run?.agents,
      run?.requestContext?.historyRefs,
      talkFilter,
    ]);
    if (ts !== talkSignature) {
      talkSignature = ts;
      const entries = conversationEntries(run, talkFilter);
      messages.replaceChildren();
      if (!entries.length) messages.append(node('p', 'まだ記録された入力・報告はありません。'));
      for (const message of entries) {
        const article = node(
          'article',
          null,
          `talk-message ${message.roleId === 'user' ? 'from-user' : ''}`,
        );
        if (message.taskId) article.dataset.taskId = message.taskId;
        article.append(
          node('strong', message.roleId === 'user' ? 'あなた' : api.role(message.roleId).name),
          node(
            'small',
            `${message.kind} · ${message.at ? new Date(message.at).toLocaleString('ja-JP') : '時刻の記録なし'}`,
          ),
        );
        const details = node('details');
        details.open =
          message.roleId === 'user' && String(valueText(message.content) || '').length < 600;
        details.append(
          node(
            'summary',
            message.roleId === 'user'
              ? '入力の全文'
              : String(valueText(message.content) || '').slice(0, 180) || '報告の全文',
          ),
          node('pre', valueText(message.content)),
        );
        article.append(details);
        messages.append(article);
      }
      const refs = run?.requestContext?.historyRefs || [];
      const box = node('aside', null, 'history-reference');
      box.append(node('h3', '参照したCodex履歴'));
      if (!refs.length) box.append(node('p', 'この依頼に履歴参照は添付されていません。'));
      refs.forEach((ref) => {
        box.append(node('strong', ref.title), node('p', `ID：${ref.id}`), node('p', ref.cwd));
      });
      box.append(
        node(
          'small',
          '履歴参照はタイトル・ID・フォルダーのみ。会話本文は未取得です。Officeの報告とCodexの元チャットは別の記録です。',
        ),
      );
      messages.append(box);
    }
    const fs = JSON.stringify([run?.id, run?.status, run?.tasks, run?.agents, run?.acceptance]);
    if (fs !== resultSignature) {
      resultSignature = fs;
      final.replaceChildren(node('p', '最終成果', 'eyebrow small'));
      const result = finalResult(run);
      final.append(
        node('h3', run?.status === 'completed' ? '指揮官の最終結果' : '最終結果はまだありません'),
      );
      if (result) {
        final.append(node('p', result.summary));
        final.append(
          node(
            'p',
            `依頼全体：${run.status === 'completed' ? '完了' : '未完了'}。担当の報告完了とユーザー受入は別の状態です。`,
            'acceptance-state',
          ),
        );
        const details = node('details');
        details.open = true;
        details.append(
          node('summary', '最終回答の全文を見る'),
          node('pre', valueText(result.content)),
        );
        final.append(details);
        const groups = verificationGroups(result);
        for (const [key, label] of [
          ['verified', '確認済み（担当報告）'],
          ['unverified', '未確認'],
          ['failed', '確認失敗'],
        ]) {
          if (!groups[key].length) continue;
          final.append(node('h4', label));
          const list = node('ul');
          groups[key].forEach((item) =>
            list.append(node('li', `${item.subject}：${item.evidence}`)),
          );
          final.append(list);
        }
        for (const [key, label] of [
          ['checks', '確認報告（区分未記録）'],
          ['issues', '残る指摘'],
        ])
          if (result[key]?.length) {
            final.append(node('h4', label));
            const list = node('ul');
            result[key].forEach((item) => list.append(node('li', valueText(item))));
            final.append(list);
          }
      } else
        final.append(
          node(
            'p',
            run?.status === 'completed'
              ? '完了状態ですが、指揮官の最終回答を確認できません。担当結果と記録を確認してください。'
              : '担当の工程終了と、依頼全体の完了は別です。途中の結果は下から確認できます。',
          ),
        );
      final.append(
        node(
          'p',
          run?.acceptance?.status === 'accepted'
            ? `あなたの受け入れ：確認済み（${new Date(run.acceptance.acceptedAt).toLocaleString('ja-JP')}）`
            : 'あなたの受け入れ：未確認',
          'acceptance-state',
        ),
      );
      const accept = action('成果を受け入れる', async () => {
        accept.disabled = true;
        const msg = node('p', '保存しています…');
        msg.setAttribute('role', 'status');
        final.append(msg);
        try {
          await api.mutate(`/api/runs/${run.id}/accept`, 'POST', {});
          await api.refresh();
        } catch (error) {
          msg.textContent = error.message;
          accept.disabled = false;
        }
      });
      accept.disabled = run?.acceptance?.status === 'accepted';
      if (result) final.append(accept);
      const follow = action('修正・追加を依頼する', () => api.followup());
      follow.disabled = !run || ['queued', 'running'].includes(run.status) || !api.canContinue();
      if (!follow.disabled) final.append(follow);
    }
    applyResultsFilter();
  }
  function selectTalk(id) {
    talkFilter = id;
    filter.value = id;
    talkSignature = '';
    update();
    navigate('talk');
  }
  function selectResults(id) {
    resultRole = id;
    resultFilter.value = id;
    applyResultsFilter();
    navigate('results');
  }
  function selectTalkTask(taskId) {
    talkFilter = 'all';
    filter.value = 'all';
    talkSignature = '';
    update();
    navigate('talk');
    const match = [...messages.querySelectorAll('[data-task-id]')].find(
      (item) => item.dataset.taskId === taskId,
    );
    match?.querySelector('summary')?.focus();
    match?.scrollIntoView({ block: 'center' });
  }
  function selectResultsTask(taskId) {
    resultRole = 'all';
    resultFilter.value = 'all';
    applyResultsFilter();
    navigate('results');
    const match = [...document.querySelectorAll('#run-results [data-task-id]')].find(
      (item) => item.dataset.taskId === taskId,
    );
    if (match) {
      match.open = true;
      match.querySelector('summary')?.focus();
      match.scrollIntoView({ block: 'center' });
    }
  }
  applyPage(location.hash.slice(1));
  if (location.hash === '#services') void refreshService();
  return { update, navigate, selectTalk, selectResults, selectTalkTask, selectResultsTask };
}
