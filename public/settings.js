// Settings are edited as a draft; live task updates never overwrite form inputs.
const duties = {
  commander: [
    '依頼の目的・完了条件・作業範囲を整理し、必要な担当を選ぶ。',
    '目的、許可範囲、資料、期待する成果を担当へ渡す。',
    '成果と未確認事項を統合し、依頼者に次の判断を示す。',
  ],
  researcher: [
    '着手前に現状、根拠、制約を調べる。',
    '情報源と未確認の点を仕様・設計担当に渡す。',
    '事実と推測を分けた調査結果を残す。',
  ],
  planner: [
    '依頼を要件と完了条件に整理する。',
    '対象、優先順位、受け入れ条件を設計・実装担当に渡す。',
    '判断が必要な点を明示した仕様案を残す。',
  ],
  architect: [
    '実現方法、影響範囲、技術上の制約を決める。',
    '構成と変更範囲、注意点を実装担当に渡す。',
    '選定理由と確認すべきリスクを説明できる。',
  ],
  designer: [
    '操作の流れと画面の分かりやすさを整える。',
    '画面案、文言、状態ごとの表示を実装担当に渡す。',
    '主要な操作と例外時の表示を確認できる案を残す。',
  ],
  builder: [
    '許可された範囲のファイルを変更し、動く成果を作る。',
    '変更点、確認結果、未検証の範囲をQAへ渡す。',
    '完了条件に対応する変更と確認結果を示す。',
  ],
  qa: [
    '期待した動作と失敗時の動作を確かめる。',
    '再現手順、実行結果、残る問題を指揮官と実装担当に渡す。',
    '確認した範囲と未確認の範囲を分けて報告する。',
  ],
  reviewer: [
    '変更内容が要件・設計と合うか確認する。',
    '根拠を添えた指摘と優先度を指揮官に渡す。',
    '重要な問題の有無と残るリスクを報告する。',
  ],
  reviewer2: [
    '別の視点から見落としや前提のずれを確認する。',
    '独立した確認結果と異なる判断の理由を指揮官に渡す。',
    '一致点・相違点と追加確認の要否を示す。',
  ],
};
const fallbackDuty = [
  '指定された計画または確認を担当する。',
  '根拠と未確認の点を指揮官に渡す。',
  '依頼された範囲の結果と残課題を示す。',
];
const clone = (value) => structuredClone(value);

export function mountSettings({ mutate, onSaved }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'settings-dialog settings-dialog-v2';
  dialog.setAttribute('aria-labelledby', 'settings-title');
  dialog.innerHTML = `<header class="settings-header"><div><h2 id="settings-title">設定</h2><p>接続と担当の設定を確認します。</p></div><button type="button" id="settings-close" aria-label="設定を閉じる">閉じる</button></header>
    <nav class="settings-jumps" aria-label="設定の項目"><a href="#agents-settings-title">仲間と役割</a><a href="#skills-settings-title">Officeスキル</a><a href="#providers-title">AIとの接続</a><a href="#global-proposal-title">Codex Globalの確認</a></nav>
    <section class="settings-panel" aria-labelledby="agents-settings-title"><div class="settings-section-heading"><div><h3 id="agents-settings-title">仲間と役割 <span id="agent-count"></span></h3></div><span id="settings-dirty-badge" class="settings-badge" aria-live="polite">読み込み中</span></div>
      <p>役割の案内を確認し、名前・役職・説明を編集できます。モデルなどの設定は担当ごとの詳細から変更できます。</p>
      <div class="settings-team"><nav id="settings-agent-list" aria-label="編集するエージェント"></nav><form id="agent-editor"></form></div>
      <div class="settings-add-row"><button type="button" id="agent-add">＋ 仲間を追加</button><span>追加担当は読み取り専用の計画・レビューに参加します。最大20人。</span></div>
    </section>
    <section class="settings-panel" aria-labelledby="skills-settings-title"><div class="settings-section-heading"><div><h3 id="skills-settings-title">Officeスキル（担当への指示）</h3></div><button type="button" id="skill-add">＋ スキルを作成</button></div><p>担当に割り当てた有効な指示を、新しい依頼のプロンプトに追加します。秘密情報は入力しないでください。外部CLIのスキル実行ではありません。</p><div class="settings-team"><nav id="settings-skill-list" aria-label="編集するスキル"></nav><div id="skill-editor"></div></div></section>
    <section class="settings-panel" aria-labelledby="providers-title"><div class="settings-section-heading"><div><h3 id="providers-title">AIとの接続</h3></div><button type="button" id="providers-refresh">接続を確認</button></div><p>このMacのCodex CLI／Claude Codeのログインを利用します。画像添付はCodex接続で利用できます。Claudeでの画像入力は未確認です。パスワードやAPIキーは保存しません。</p><div id="providers-list" class="providers-list"></div></section>
    <section class="settings-panel settings-global" aria-labelledby="global-proposal-title"><div class="settings-section-heading"><div><h3 id="global-proposal-title">Codex Globalの確認</h3></div><span class="settings-badge settings-badge-muted">適用は未対応</span></div>
      <p>ここで保存されるのはOfficeの設定です。Codex Globalへの反映はまだ実装されていません。</p>
      <div id="global-current" class="settings-global-current" role="status">Globalの情報を確認中…</div>
      <details id="global-proposal"><summary>Officeから反映する候補を見る</summary><p>以下はOfficeの入力内容です。Globalの実ファイルとの差分ではありません。</p><div id="global-proposal-list" class="settings-global-list"></div><p>Codex接続の担当のみが対象です。共通のAGENTS.mdは含めません。</p></details>
      <button type="button" disabled aria-describedby="global-unavailable">Codex Globalへ適用</button><p id="global-unavailable" class="settings-footnote">確認用です。実ファイルの確認、競合解決、バックアップと復元の準備が必要なため、書き込みは行いません。</p>
    </section>
    <footer class="settings-footer"><span id="settings-message" role="status" aria-live="polite"></span><button type="button" id="settings-save" class="primary-button" disabled>設定を保存</button></footer>`;
  document.body.append(dialog);
  const settingsLinks = [...dialog.querySelectorAll('.settings-jumps a')];
  const settingsPanels = [...dialog.querySelectorAll('.settings-panel')];
  function showSettingsPanel(link, focus = false) {
    const target = dialog.querySelector(link.getAttribute('href'));
    for (const panel of settingsPanels) panel.hidden = panel !== target.closest('.settings-panel');
    for (const item of settingsLinks)
      item.setAttribute('aria-current', item === link ? 'page' : 'false');
    if (focus) {
      target.tabIndex = -1;
      target.focus({ preventScroll: true });
    }
  }
  showSettingsPanel(settingsLinks[0]);
  dialog.querySelector('.settings-jumps').addEventListener('click', (event) => {
    const link = event.target.closest('a');
    if (!link) return;
    const target = dialog.querySelector(link.getAttribute('href'));
    if (!target) return;
    event.preventDefault();
    showSettingsPanel(link, true);
  });
  const $ = (id) => dialog.querySelector('#' + id);
  const text = (tag, value, className) => {
    const element = document.createElement(tag);
    element.textContent = value;
    if (className) element.className = className;
    return element;
  };
  let draft = null;
  let saved = null;
  let selected = null;
  let selectedSkill = null;
  let saving = false;
  let providerBusy = false;
  let advancedOpen = false;
  const dirty = () => draft && saved && JSON.stringify(draft) !== JSON.stringify(saved);
  const message = (value, error = false) => {
    $('settings-message').textContent = value;
    $('settings-message').dataset.error = String(error);
  };
  function updateState() {
    const changed = dirty();
    $('settings-dirty-badge').textContent = !draft
      ? '読み込み中'
      : changed
        ? '未保存の変更'
        : '保存済み';
    $('settings-dirty-badge').classList.toggle('is-dirty', Boolean(changed));
    $('settings-save').disabled = saving || !changed;
    $('agent-add').disabled = saving || !draft || draft.agents.length >= 20;
    $('skill-add').disabled = saving || !draft || draft.skills.length >= 100;
    $('agent-count').textContent = draft ? `${draft.agents.length}人` : '';
  }
  function changed() {
    updateState();
    renderGlobalProposal();
    message(dirty() ? '未保存の変更があります。保存後に開始する依頼から反映します。' : '');
  }
  function renderProviders(providers) {
    $('providers-list').replaceChildren();
    for (const id of ['codex', 'claude']) {
      const provider = providers?.[id] || {};
      const card = text('article', '', 'provider-card');
      const status = !provider.available
        ? '未インストール'
        : provider.authenticated === true
          ? 'ログイン確認済み'
          : provider.authenticated === false
            ? 'ログインが必要'
            : '認証状態は未確認';
      card.append(
        text('h4', id === 'codex' ? 'Codex' : 'Claude Code'),
        text('strong', status, provider.authenticated === true ? 'provider-ok' : ''),
        text('p', provider.message || provider.version || '接続を確認してください。'),
      );
      if (provider.authenticated !== true) {
        card.append(text('p', 'ターミナルでログインした後、接続を再確認してください。'));
        card.append(text('code', id === 'codex' ? 'codex login' : 'claude auth login'));
      }
      if (id === 'claude')
        card.append(
          text(
            'p',
            'Claude連携は読み取り・編集ツールに限定します。コマンド実行やブラウザ検証はこの接続では行えません。',
          ),
        );
      const link = text('a', '公式セットアップ手順');
      link.href =
        id === 'codex'
          ? 'https://learn.chatgpt.com/docs/cli'
          : 'https://code.claude.com/docs/en/setup';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      card.append(link);
      $('providers-list').append(card);
    }
  }
  function renderList() {
    const list = $('settings-agent-list');
    list.replaceChildren();
    if (!draft) return;
    for (const agent of draft.agents) {
      const button = text('button', '', 'settings-agent-button');
      button.type = 'button';
      button.setAttribute('aria-pressed', String(agent.id === selected));
      button.append(text('strong', agent.name), text('span', agent.title));
      if (agent.id.startsWith('custom_')) button.append(text('small', '追加担当'));
      button.addEventListener('click', () => {
        selected = agent.id;
        renderList();
        renderEditor();
      });
      list.append(button);
    }
    updateState();
  }
  function field(agent, key, label, { type = 'input', options, maxLength, hint } = {}) {
    const wrap = document.createElement('label');
    wrap.className = type === 'checkbox' ? 'settings-checkbox' : 'settings-field';
    const caption = text('span', label);
    const input = document.createElement(
      type === 'textarea' ? 'textarea' : options ? 'select' : 'input',
    );
    input.name = key;
    input.id = 'agent-setting-' + key;
    if (type === 'checkbox') {
      input.type = 'checkbox';
      input.checked = agent[key] !== false;
      wrap.append(input, caption);
    } else {
      if (options)
        for (const [value, title] of options) {
          const option = text('option', title);
          option.value = value;
          input.append(option);
        }
      input.value = agent[key] ?? '';
      if (maxLength) input.maxLength = maxLength;
      if (type === 'textarea') input.rows = key === 'instructions' ? 4 : 3;
      wrap.append(caption, input);
    }
    if (hint) wrap.append(text('small', hint, 'settings-field-hint'));
    input.addEventListener(type === 'checkbox' || options ? 'change' : 'input', () => {
      agent[key] = type === 'checkbox' ? input.checked : input.value;
      if (['model', 'effort'].includes(key)) {
        agent.useModeDefaults = false;
        const toggle = $('agent-editor').querySelector('[name=useModeDefaults]');
        if (toggle) toggle.checked = false;
      }
      if (key === 'provider') {
        agent.useModeDefaults = false;
        agent.model = input.value === 'claude' ? 'sonnet' : 'gpt-6-sol';
        agent.effort = 'high';
        renderEditor();
      }
      if (['name', 'title'].includes(key)) renderList();
      changed();
    });
    return wrap;
  }
  function renderDuty(agent) {
    const [purpose, handoff, completion] = duties[agent.id] || fallbackDuty;
    const panel = text('div', '', 'settings-duty');
    panel.append(text('h5', 'この担当の仕事の目安'));
    const list = document.createElement('dl');
    for (const [label, content] of [
      ['担当すること', purpose],
      ['次の担当へ渡すこと', handoff],
      ['終わりの目安', completion],
    ]) {
      const row = document.createElement('div');
      row.append(text('dt', label), text('dd', content));
      list.append(row);
    }
    panel.append(
      list,
      text(
        'p',
        '案内は役割を理解するための説明です。実行時に使う説明・指示は下の入力欄で変更できます。',
      ),
    );
    return panel;
  }
  function renderEditor() {
    const editor = $('agent-editor');
    editor.replaceChildren();
    const agent = draft?.agents.find((item) => item.id === selected);
    if (!agent) return;
    const head = text('div', '', 'settings-editor-head');
    const heading = text('div');
    heading.append(
      text('small', agent.id.startsWith('custom_') ? '追加した担当' : '標準の担当'),
      text('h4', `${agent.name}の設定`),
    );
    head.append(heading);
    if (agent.id.startsWith('custom_')) {
      const remove = text('button', 'この仲間を削除', 'settings-remove');
      remove.type = 'button';
      remove.addEventListener('click', () => {
        draft.agents = draft.agents.filter((item) => item.id !== agent.id);
        selected = draft.agents[0]?.id;
        renderList();
        renderEditor();
        changed();
      });
      head.append(remove);
    }
    editor.append(head, renderDuty(agent));
    const basic = text('div', '', 'settings-fields');
    basic.append(
      field(agent, 'name', '名前', { maxLength: 80 }),
      field(agent, 'title', '役職・担当名', { maxLength: 120 }),
      field(agent, 'description', '役割の説明', {
        type: 'textarea',
        maxLength: 1000,
        hint: '次の依頼から担当に渡す説明です。',
      }),
    );
    editor.append(basic);
    const skills = text('section', '', 'settings-skill-assignment');
    skills.append(text('h5', '割り当てるOfficeスキル'));
    for (const skill of draft.skills || []) {
      const row = document.createElement('label');
      row.className = 'settings-checkbox';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = (agent.skillIds || []).includes(skill.id);
      input.addEventListener('change', () => {
        agent.skillIds ||= [];
        agent.skillIds = input.checked
          ? [...agent.skillIds, skill.id]
          : agent.skillIds.filter((id) => id !== skill.id);
        changed();
      });
      row.append(
        input,
        text(
          'span',
          `${skill.name} · 版${skill.revision}${skill.enabled ? '' : '（無効・未適用）'}`,
        ),
      );
      skills.append(row);
    }
    for (const id of agent.skillIds || []) {
      if (draft.skills?.some((skill) => skill.id === id)) continue;
      const remove = text('button', `参照不能 ${id} の割当を解除`, 'text-button');
      remove.type = 'button';
      remove.addEventListener('click', () => {
        agent.skillIds = agent.skillIds.filter((item) => item !== id);
        renderEditor();
        changed();
      });
      skills.append(remove);
    }
    if (!(draft.skills || []).length)
      skills.append(text('p', 'スキル定義はまだありません。下のOfficeスキル欄で作成できます。'));
    editor.append(skills);
    const advanced = document.createElement('details');
    advanced.className = 'settings-advanced';
    advanced.open = advancedOpen;
    advanced.addEventListener('toggle', () => {
      advancedOpen = advanced.open;
    });
    advanced.append(text('summary', '詳細設定 · AI、モデル、推論、追加指示'));
    const grid = text('div', '', 'settings-fields');
    grid.append(
      field(agent, 'provider', '利用するAI', {
        options: [
          ['codex', 'Codex'],
          ['claude', 'Claude Code'],
        ],
      }),
      field(agent, 'model', 'モデル名', {
        maxLength: 80,
        hint: '接続先で使えるモデル名を指定します。利用可否は実行時に確認します。',
      }),
    );
    grid.append(
      field(agent, 'effort', '推論の強さ', {
        options: (agent.provider === 'claude'
          ? ['low', 'medium', 'high', 'max']
          : ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
        ).map((value) => [value, value]),
      }),
    );
    if (agent.provider === 'codex')
      grid.append(
        field(agent, 'useModeDefaults', '依頼の進め方に合わせてモデル・推論強度を調整', {
          type: 'checkbox',
          hint: 'オンの場合、依頼の進め方によって上の値が変わることがあります。',
        }),
      );
    grid.append(
      field(agent, 'instructions', 'この担当への追加指示', {
        type: 'textarea',
        maxLength: 8000,
        hint: '共通ルールとは別の、担当だけに渡す指示です。空欄なら追加指示はありません。',
      }),
    );
    if (agent.id.startsWith('custom_'))
      grid.append(
        field(agent, 'stage', '参加する工程', {
          options: [
            ['planning', '実装前の専門担当（読み取り専用）'],
            ['review', '追加レビュー（読み取り専用）'],
          ],
        }),
        field(agent, 'enabled', '新しい依頼に参加する', { type: 'checkbox' }),
      );
    if (agent.provider === 'claude')
      grid.append(
        text(
          'p',
          'Claude接続では読み取り・編集ツールのみ使います。コマンド実行やブラウザ検証を必要とする仕事は、この接続では行えません。',
          'settings-capability-note',
        ),
      );
    advanced.append(
      grid,
      text(
        'p',
        agent.id.startsWith('custom_')
          ? '追加担当はファイルを変更せず、成果を実装担当・指揮官へ渡します。追加レビューの合格も完了条件になります。'
          : '既存の工程と権限は維持します。変更は新しく開始する依頼から反映します。',
        'settings-footnote',
      ),
    );
    editor.append(advanced);
  }
  function renderSkills() {
    const list = $('settings-skill-list');
    const editor = $('skill-editor');
    list.replaceChildren();
    editor.replaceChildren();
    if (!draft) return;
    for (const skill of draft.skills || []) {
      const button = text(
        'button',
        `${skill.name} · 版${skill.revision}${skill.enabled ? '' : ' · 無効'}`,
        'settings-agent-button',
      );
      button.type = 'button';
      button.setAttribute('aria-pressed', String(skill.id === selectedSkill));
      button.addEventListener('click', () => {
        selectedSkill = skill.id;
        renderSkills();
      });
      list.append(button);
    }
    const skill = draft.skills?.find((item) => item.id === selectedSkill);
    if (!skill) {
      editor.append(text('p', 'スキルを選ぶか作成してください。'));
      return;
    }
    editor.append(text('h4', `${skill.name} · 版${skill.revision}`));
    for (const [key, label, max] of [
      ['name', 'スキル名', 80],
      ['description', '説明', 1000],
      ['instructions', '担当へ渡す指示', 8000],
    ]) {
      const row = document.createElement('label');
      row.className = 'settings-field';
      const input = document.createElement(key === 'instructions' ? 'textarea' : 'input');
      input.value = skill[key];
      input.maxLength = max;
      if (key === 'instructions') input.rows = 6;
      input.addEventListener('input', () => {
        skill[key] = input.value;
        if (key === 'name') {
          editor.querySelector('h4').textContent = `${skill.name} · 版${skill.revision}`;
          const selectedButton = list.querySelector('[aria-pressed="true"]');
          if (selectedButton)
            selectedButton.textContent = `${skill.name} · 版${skill.revision}${skill.enabled ? '' : ' · 無効'}`;
        }
        changed();
      });
      row.append(text('span', label), input);
      editor.append(row);
    }
    const active = document.createElement('label');
    active.className = 'settings-checkbox';
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = skill.enabled;
    toggle.addEventListener('change', () => {
      skill.enabled = toggle.checked;
      renderEditor();
      changed();
    });
    active.append(toggle, text('span', '新しい依頼で有効にする'));
    editor.append(active);
    const remove = text('button', 'この定義を削除', 'settings-remove');
    remove.type = 'button';
    remove.addEventListener('click', () => {
      draft.skills = draft.skills.filter((item) => item.id !== skill.id);
      selectedSkill = draft.skills[0]?.id || null;
      renderSkills();
      renderEditor();
      changed();
    });
    editor.append(
      remove,
      text(
        'p',
        '削除後も担当に残る割当は参照不能として表示し、解除できます。',
        'settings-footnote',
      ),
    );
  }
  function renderGlobalProposal() {
    const list = $('global-proposal-list');
    list.replaceChildren();
    if (!draft) return;
    for (const agent of draft.agents.filter((item) => item.provider === 'codex')) {
      const row = document.createElement('details');
      row.className = 'settings-global-row';
      const summary = text('summary');
      summary.append(
        text('strong', `${agent.name} · ${agent.title}`),
        text(
          'span',
          `モデル ${agent.model} / 推論 ${agent.effort}${agent.useModeDefaults ? '（依頼の進め方で調整あり）' : ''}`,
        ),
        text(
          'small',
          `${agent.instructions ? '追加指示あり' : '追加指示なし'} · ${agent.enabled ? '参加' : '不参加'}`,
        ),
      );
      row.append(
        summary,
        text('p', `役割の説明: ${agent.description || '未設定'}`),
        text('p', `追加指示: ${agent.instructions || 'なし'}`),
      );
      list.append(row);
    }
    if (!list.children.length) list.append(text('p', 'Codex接続の担当はいません。'));
  }
  async function refreshGlobal() {
    const current = $('global-current');
    current.replaceChildren(text('p', 'Codex Globalの情報を確認中…'));
    try {
      const response = await fetch('/api/codex/global', { cache: 'no-store' });
      if (!response.ok) throw Error('Codex Globalの情報を取得できませんでした。');
      const data = await response.json();
      current.replaceChildren();
      if (data.status !== 'read') {
        current.append(text('p', data.note || 'Codex Globalの情報は取得できませんでした。'));
        return;
      }
      current.append(text('strong', '読み取り結果'));
      const rows = [
        ['既定モデル', data.fields?.model || '未設定'],
        ['既定の推論強度', data.fields?.model_reasoning_effort || '未設定'],
        [
          '担当別定義',
          Array.isArray(data.agentRoleIds)
            ? `${data.agentRoleIds.length}件の名前を検出（内容は未取得）`
            : '未確認',
        ],
      ];
      const list = document.createElement('dl');
      for (const [label, value] of rows) {
        const row = document.createElement('div');
        row.append(text('dt', label), text('dd', value));
        list.append(row);
      }
      current.append(
        list,
        text(
          'p',
          '設定ファイルの存在と一部の項目のみを読み取りました。担当別ファイルの内容は確認していません。',
        ),
      );
      if (data.note) current.append(text('p', data.note));
    } catch (error) {
      current.replaceChildren(text('p', error.message));
    }
  }
  async function refreshProviders() {
    if (providerBusy) return;
    providerBusy = true;
    $('providers-refresh').disabled = true;
    try {
      const data = await mutate('/api/providers/check', 'POST', {});
      renderProviders(data.providers);
      message('接続状態を更新しました。');
    } catch (error) {
      message(error.message, true);
    } finally {
      providerBusy = false;
      $('providers-refresh').disabled = false;
    }
  }
  $('providers-refresh').addEventListener('click', refreshProviders);
  $('settings-close').addEventListener('click', () => dialog.close());
  $('agent-editor').addEventListener('submit', (event) => event.preventDefault());
  $('agent-add').addEventListener('click', () => {
    if (!draft || draft.agents.length >= 20) return;
    const agent = {
      id: 'custom_' + crypto.randomUUID().replaceAll('-', ''),
      name: '新しい仲間',
      title: '専門担当',
      description: '依頼に必要な専門的な確認を行い、実装担当へ引き継ぎます。',
      instructions: '',
      skillIds: [],
      provider: 'codex',
      model: 'gpt-6-sol',
      effort: 'medium',
      stage: 'planning',
      enabled: true,
      useModeDefaults: false,
    };
    draft.agents.push(agent);
    selected = agent.id;
    advancedOpen = true;
    renderList();
    renderEditor();
    changed();
  });
  $('skill-add').addEventListener('click', () => {
    if (!draft || draft.skills.length >= 100) return;
    const skill = {
      id: 'skill_' + crypto.randomUUID(),
      name: '新しいスキル',
      description: '',
      instructions: '担当への指示を入力してください。',
      revision: 1,
      enabled: true,
    };
    draft.skills.push(skill);
    selectedSkill = skill.id;
    renderSkills();
    renderEditor();
    changed();
  });
  $('settings-save').addEventListener('click', async () => {
    if (saving || !dirty()) return;
    saving = true;
    updateState();
    $('agent-editor').inert = true;
    $('settings-agent-list').inert = true;
    $('settings-skill-list').inert = true;
    $('skill-editor').inert = true;
    $('agent-add').disabled = true;
    message('設定を保存中…');
    try {
      const data = await mutate('/api/settings', 'POST', draft);
      draft = clone(data.settings);
      saved = clone(data.settings);
      renderList();
      renderEditor();
      renderSkills();
      renderGlobalProposal();
      message('保存しました。次に開始する依頼から反映します。');
      try {
        await onSaved();
      } catch (error) {
        message(`保存しましたが、画面の更新に失敗しました: ${error.message}`, true);
      }
    } catch (error) {
      message(`${error.message} 入力内容は保持しています。`, true);
    } finally {
      saving = false;
      $('agent-editor').inert = false;
      $('settings-agent-list').inert = false;
      $('settings-skill-list').inert = false;
      $('skill-editor').inert = false;
      updateState();
    }
  });
  async function openSettings() {
    dialog.showModal();
    refreshGlobal();
    if (dirty()) {
      message('未保存の変更を保持しています。保存後に開始する依頼から反映します。');
      return;
    }
    message('設定を読み込み中…');
    $('settings-save').disabled = true;
    $('agent-add').disabled = true;
    try {
      const response = await fetch('/api/settings', { cache: 'no-store' });
      if (!response.ok) throw Error('設定を取得できませんでした。');
      const data = await response.json();
      draft = clone(data.settings);
      saved = clone(data.settings);
      selected = draft.agents.some((item) => item.id === selected) ? selected : draft.agents[0]?.id;
      renderProviders(data.providers);
      renderList();
      renderEditor();
      selectedSkill = draft.skills.some((item) => item.id === selectedSkill)
        ? selectedSkill
        : draft.skills[0]?.id;
      renderSkills();
      renderGlobalProposal();
      message('設定は保存済みです。変更すると次の依頼から反映できます。');
    } catch (error) {
      message(error.message, true);
    } finally {
      updateState();
    }
  }
  document.getElementById('open-settings').addEventListener('click', openSettings);
}
