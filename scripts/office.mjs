import { readFileSync } from 'node:fs';
import { openOfficeWindow } from '../lib/office-window.mjs';
import { assertOfficeIntake } from '../lib/office-boundary.mjs';
import { ensureOffice, localOrigin, readOffice, submitToOffice } from '../lib/office-client.mjs';
import { projectSetupInstruction } from '../public/project-setup.js';

const args = process.argv.slice(2);
const values = {};
try {
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--no-open') {
      values.noOpen = true;
      continue;
    }
    if (flag === '--state') {
      values.state = true;
      continue;
    }
    if (
      ![
        '--workspace',
        '--instruction-file',
        '--project-purpose-file',
        '--undecided-tech-file',
        '--continue',
        '--status',
        '--show',
        '--port',
      ].includes(flag) ||
      !args[i + 1] ||
      args[i + 1].startsWith('--')
    )
      throw Error(
        '使い方: node scripts/office.mjs --workspace /absolute/project --instruction-file /path/request.txt [--no-open] [--port 4317]、新規準備は --workspace PATH --project-purpose-file FILE [--undecided-tech-file FILE] [--instruction-file FILE]。状態は --status ID / --show ID / --state、継続は --continue ID --instruction-file FILE',
      );
    values[flag.slice(2)] = args[++i];
  }
  const port = Number(values.port || 4317);
  if (process.env.AGENT_OFFICE_WORKER === '1' && !values.status && !values.state)
    assertOfficeIntake();
  if (values.status || values.show || values.state) {
    if (values.show) await ensureOffice(port, { preferDesktop: !values.noOpen });
    const state = await readOffice(localOrigin(port));
    if (values.state) {
      console.log(
        JSON.stringify(
          {
            activeRunId: state.activeRunId || null,
            runs: state.runs.slice(0, 10).map((run) => ({
              id: run.id,
              status: run.status,
              stage: run.stage,
              instruction: run.instruction,
            })),
          },
          null,
          2,
        ),
      );
    } else {
      const run = state.runs.find((run) => run.id === (values.status || values.show));
      if (!run) throw Error('依頼が見つかりません');
      if (values.show && !values.noOpen) await openOfficeWindow({ runId: run.id, port });
      console.log(
        JSON.stringify(
          {
            id: run.id,
            status: run.status,
            dispatch: run.dispatch,
            instruction: run.rootInstruction || run.instruction,
            additions: run.userAdditions || [],
            tasks: run.tasks,
            error: run.error,
            url: `${localOrigin(port)}/?run=${run.id}`,
          },
          null,
          2,
        ),
      );
    }
  } else {
    assertOfficeIntake();
    if (
      (!values['instruction-file'] && !values['project-purpose-file']) ||
      (!values.workspace && !values.continue) ||
      (values.workspace && values.continue) ||
      (values['project-purpose-file'] && values.continue) ||
      (values['undecided-tech-file'] && !values['project-purpose-file'])
    )
      throw Error('依頼ファイルと作業フォルダ、または継続元IDを指定してください');
    const instruction = values['project-purpose-file']
      ? projectSetupInstruction({
          purpose: readFileSync(values['project-purpose-file'], 'utf8'),
          workspace: values.workspace,
          undecidedTech: values['undecided-tech-file']
            ? readFileSync(values['undecided-tech-file'], 'utf8')
            : '',
          context: values['instruction-file']
            ? readFileSync(values['instruction-file'], 'utf8')
            : '',
        })
      : readFileSync(values['instruction-file'], 'utf8').trim();
    if (!instruction || instruction.length > 20000)
      throw Error('指示は1〜20,000文字で指定してください');
    const origin = await ensureOffice(port, { preferDesktop: !values.noOpen });
    const result = await submitToOffice(origin, {
      instruction,
      ...(values['project-purpose-file'] ? { kind: 'project-setup' } : {}),
      ...(values.continue
        ? { continueFromRunId: values.continue }
        : { workspace: values.workspace }),
    });
    console.log(JSON.stringify(result, null, 2));
    if (!values.noOpen && process.platform === 'darwin') {
      try {
        await openOfficeWindow({ runId: result.id, port });
      } catch {
        console.error(
          '依頼は受け付け済みです。出力されたURLから確認してください。再送はしないでください。',
        );
      }
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
