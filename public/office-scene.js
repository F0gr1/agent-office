import * as THREE from 'three/webgpu';

const PEOPLE = [
  { id: 'commander', room: 'ceo', x: -7, z: -3.95, color: 0xf4b58f, ear: 'round' },
  { id: 'researcher', room: 'planning', x: 3, z: -5.15, color: 0xa9d9c8, ear: 'point' },
  { id: 'planner', room: 'planning', x: 6.95, z: -5.1, color: 0xb9d59b, ear: 'round' },
  { id: 'architect', room: 'planning', x: 3, z: -2.15, color: 0xcbb9df, ear: 'point' },
  { id: 'designer', room: 'planning', x: 6.95, z: -2.1, color: 0xf2ca91, ear: 'round' },
  { id: 'builder', room: 'workshop', x: -7.65, z: 2.7, color: 0xd9bd99, ear: 'round' },
  { id: 'qa', room: 'workshop', x: -3.3, z: 4.9, color: 0xaed1d9, ear: 'point' },
  { id: 'reviewer', room: 'review', x: 2.95, z: 2.7, color: 0xb9c9e9, ear: 'round' },
  { id: 'reviewer2', room: 'review', x: 7.05, z: 4.8, color: 0xe9bbc4, ear: 'point' },
];
const CONSULTATION_POSITION = { x: -8.2, z: -1.95 };
const TRANSIT_DURATION = 1100;

const ROOM_DATA = [
  {
    id: 'ceo',
    name: '社長室',
    x: -5.56,
    z: -3.63,
    w: 10.69,
    d: 6.81,
    floor: 0xffeadb,
    wall: 0xffddc8,
  },
  {
    id: 'planning',
    name: '企画室',
    x: 5.56,
    z: -3.63,
    w: 10.69,
    d: 6.81,
    floor: 0xe8f2e2,
    wall: 0xd8eacc,
  },
  {
    id: 'workshop',
    name: '作業部屋',
    x: -5.56,
    z: 3.63,
    w: 10.69,
    d: 6.81,
    floor: 0xf5eadb,
    wall: 0xeee0c8,
  },
  {
    id: 'review',
    name: 'レビュー室',
    x: 5.56,
    z: 3.63,
    w: 10.69,
    d: 6.81,
    floor: 0xe8eefb,
    wall: 0xd9e5f7,
  },
];

const STATUS = {
  working: { label: '作業中', color: 0x62bc9a, className: 'working' },
  done: { label: '完了', color: 0x8d9cda, className: 'done' },
  blocked: { label: '確認が必要', color: 0xdc9d6d, className: 'blocked' },
  idle: { label: '待機中', color: 0xb9b7b0, className: 'idle' },
  skipped: { label: '今回は参加なし', color: 0xc6c5c0, className: 'skipped' },
  stopped: { label: '作業停止', color: 0xb9b7b0, className: 'stopped' },
  legacy: { label: 'この依頼には未参加', color: 0xc6c5c0, className: 'skipped' },
  unknown: { label: '状況を確認中', color: 0xb9b7b0, className: 'unknown' },
};

const mat = (color, extras = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.86, ...extras });
let sphereGeometry = new THREE.SphereGeometry(1, 18, 12);
let boxGeometry = new THREE.BoxGeometry(1, 1, 1);
let cylinderGeometry = new THREE.CylinderGeometry(1, 1, 1, 16);
let geometryUsers = 0;
let sharedDisposed = false;

function mesh(parent, geometry, material, x, y, z, sx = 1, sy = 1, sz = 1) {
  const item = new THREE.Mesh(geometry, material);
  item.position.set(x, y, z);
  item.scale.set(sx, sy, sz);
  item.castShadow = true;
  item.receiveShadow = true;
  parent.add(item);
  return item;
}

function box(parent, material, x, y, z, w, h, d) {
  return mesh(parent, boxGeometry, material, x, y, z, w, h, d);
}

function oval(parent, material, x, y, z, w, h, d) {
  return mesh(parent, sphereGeometry, material, x, y, z, w, h, d);
}

function addDesk(parent, x, z, angle = 0, screenColor = 0x95b6ad) {
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  group.rotation.y = angle;
  parent.add(group);
  const wood = mat(0xe8caaa);
  const leg = mat(0x9d8d85);
  const screen = mat(0xf9faf5);
  box(group, wood, 0, 0.76, 0, 1.53, 0.13, 0.82);
  [-0.63, 0.63].forEach((dx) => {
    [-0.28, 0.28].forEach((dz) => box(group, leg, dx, 0.38, dz, 0.085, 0.7, 0.085));
  });
  box(group, leg, 0, 1.13, -0.16, 0.09, 0.45, 0.08);
  box(group, screen, 0, 1.33, -0.17, 0.9, 0.61, 0.09);
  box(
    group,
    mat(screenColor, { emissive: screenColor, emissiveIntensity: 0.13 }),
    0,
    1.34,
    -0.115,
    0.75,
    0.46,
    0.018,
  );
  box(group, mat(0xffffff), -0.13, 0.84, 0.18, 0.75, 0.025, 0.24);
  return group;
}

function addPlant(parent, x, z, scale = 1) {
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  group.scale.setScalar(scale);
  parent.add(group);
  const pot = mat(0xe3a894);
  const leaf = mat(0x7ba989);
  mesh(group, cylinderGeometry, pot, 0, 0.26, 0, 0.34, 0.48, 0.34);
  oval(group, leaf, 0, 0.8, 0, 0.28, 0.52, 0.28);
  oval(group, leaf, -0.22, 0.68, 0.05, 0.2, 0.36, 0.2).rotation.z = 0.55;
  oval(group, leaf, 0.23, 0.7, -0.03, 0.2, 0.35, 0.2).rotation.z = -0.52;
}

function addCharacter(parent, person) {
  const root = new THREE.Group();
  root.position.set(person.x, 0, person.z);
  parent.add(root);
  const body = mat(person.color);
  const light = mat(new THREE.Color(person.color).lerp(new THREE.Color(0xffffff), 0.45));
  const blush = mat(0xe99fa5);
  const ink = mat(0x4f464c);
  const white = mat(0xffffff);
  // Large head and tiny limbs keep expressions legible even when the entire office fits on screen.
  oval(root, body, 0, 0.81, 0, 0.48, 0.55, 0.43);
  oval(root, body, 0, 1.56, 0, 0.63, 0.58, 0.55);
  oval(root, light, 0, 1.41, 0.47, 0.39, 0.28, 0.1);
  const arms = [];
  const feet = [];
  [-1, 1].forEach((side) => {
    const ear = oval(
      root,
      body,
      side * 0.42,
      2.08,
      -0.06,
      0.22,
      person.ear === 'point' ? 0.44 : 0.32,
      0.2,
    );
    ear.rotation.z = side * -0.2;
    oval(root, light, side * 0.43, 2.1, 0.11, 0.11, 0.2, 0.045);
    oval(root, ink, side * 0.23, 1.68, 0.48, 0.067, 0.09, 0.055);
    oval(root, white, side * 0.245 - 0.018, 1.71, 0.53, 0.023, 0.025, 0.018);
    oval(root, blush, side * 0.41, 1.48, 0.38, 0.105, 0.055, 0.03);
    const arm = oval(root, body, side * 0.46, 0.94, 0.1, 0.16, 0.31, 0.15);
    arm.rotation.z = side * 0.35;
    arms.push(arm);
    feet.push(oval(root, body, side * 0.23, 0.25, 0.14, 0.2, 0.24, 0.24));
  });
  oval(root, ink, 0, 1.52, 0.55, 0.065, 0.045, 0.04);
  oval(root, ink, 0, 1.38, 0.53, 0.1, 0.025, 0.025);
  root.userData.limbs = { arms, feet };
  return root;
}

function createRoom(scene, data) {
  const floor = mat(data.floor);
  const walls = mat(data.wall, { side: THREE.DoubleSide });
  const trim = mat(0xffffff);
  box(scene, floor, data.x, -0.08, data.z, data.w, 0.22, data.d);
  // Low walls define rooms without obscuring their furniture or characters.
  box(scene, walls, data.x, 0.46, data.z - data.d / 2, data.w, 1.05, 0.14);
  box(scene, walls, data.x - data.w / 2, 0.46, data.z, 0.14, 1.05, data.d);
  box(scene, trim, data.x, 0.99, data.z - data.d / 2, data.w, 0.09, 0.18);
  box(scene, trim, data.x - data.w / 2, 0.99, data.z, 0.18, 0.09, data.d);
  return new THREE.Vector3(data.x, 0.25, data.z - data.d / 2 + 0.55);
}

function shorten(value, max = 64) {
  const clean = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function statusFor(value, connected) {
  if (!connected && value === 'working') return STATUS.unknown;
  return STATUS[value] || STATUS.unknown;
}

/** Create a self-contained, disposable office diorama. The caller owns data and selection. */
export function createOfficeScene(
  container,
  { onSelect, extraAgents = [], forceWebGL = false } = {},
) {
  if (!(container instanceof Element)) throw new TypeError('A container element is required.');
  const host = document.createElement('div');
  host.className = 'three-office__stage';
  const canvasArea = document.createElement('div');
  canvasArea.className = 'three-office__canvas';
  const overlay = document.createElement('div');
  overlay.className = 'three-office__overlay';
  const engine = document.createElement('span');
  engine.className = 'three-office__engine';
  engine.setAttribute('role', 'status');
  engine.textContent = '3D表示を準備中';
  host.append(canvasArea, overlay, engine);
  container.append(host);

  let renderer = null;
  let rendererReady = false;
  let fallback = null;
  if (sharedDisposed) {
    sphereGeometry = new THREE.SphereGeometry(1, 18, 12);
    boxGeometry = new THREE.BoxGeometry(1, 1, 1);
    cylinderGeometry = new THREE.CylinderGeometry(1, 1, 1, 16);
    sharedDisposed = false;
  }
  geometryUsers += 1;

  const extras = (Array.isArray(extraAgents) ? extraAgents : [])
    .filter((agent) => agent && typeof agent.id === 'string' && agent.id.startsWith('custom_'))
    .slice(0, 11)
    .map((agent, index) => ({
      id: agent.id,
      room: 'extension',
      x: -9 + (index % 6) * 3.6,
      z: index < 6 ? 9.75 : 13.15,
      color: [0xb5d4d4, 0xe4bfac, 0xc4cee7, 0xd6d09f, 0xe0bcca, 0xb4d4b2][index % 6],
      ear: index % 2 ? 'point' : 'round',
    }));
  const people = [...PEOPLE, ...extras];
  const rooms = extras.length
    ? [
        ...ROOM_DATA,
        {
          id: 'extension',
          name: '追加エージェント室',
          x: 0,
          z: 11.45,
          w: 22.05,
          d: 7.7,
          floor: 0xe8f2f1,
          wall: 0xcfe5e2,
        },
      ]
    : ROOM_DATA;
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera();
  const cameraCenterZ = extras.length ? 4 : 0;
  camera.position.set(18, 23, 26 + cameraCenterZ);
  camera.lookAt(0, 0.75, cameraCenterZ);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xd5c8bf, 2.55));
  const sunlight = new THREE.DirectionalLight(0xffffff, 2.8);
  sunlight.position.set(-7, 18, 13);
  sunlight.castShadow = true;
  sunlight.shadow.mapSize.set(1024, 1024);
  sunlight.shadow.camera.left = -20;
  sunlight.shadow.camera.right = 20;
  sunlight.shadow.camera.top = 20;
  sunlight.shadow.camera.bottom = -20;
  sunlight.shadow.bias = -0.0003;
  scene.add(sunlight);

  const base = mat(0xf7f0e8);
  box(scene, base, 0, -0.34, 0, 23.3, 0.38, 15.1);
  box(scene, mat(0xe1d4c7), 0, -0.61, 0, 23.56, 0.17, 15.32);
  if (extras.length) {
    box(scene, base, 0, -0.34, 11.5, 23.3, 0.38, 8.4);
    box(scene, mat(0xe1d4c7), 0, -0.61, 11.5, 23.56, 0.17, 8.62);
  }
  const roomAnchors = new Map(rooms.map((room) => [room.id, createRoom(scene, room)]));
  // Shared decorations make the spaces distinct at a glance.
  addPlant(scene, -10, -1.55, 0.9);
  addPlant(scene, 9.95, -1.6, 0.9);
  addPlant(scene, -10, 5.95, 0.95);
  addPlant(scene, 9.95, 5.95, 0.95);
  addDesk(scene, -4.3, -4.05, -0.12, 0xf6c4a5);
  box(scene, mat(0xd4bba9), -8.7, 0.45, -5.85, 1.65, 0.78, 0.36); // CEO bookshelf
  [3, 6.95].forEach((x) => {
    addDesk(scene, x + 0.48, -4.05, 0.05, 0xa6d1bc);
    addDesk(scene, x + 0.48, -1.12, 0.05, 0xc6dbaa);
  });
  addDesk(scene, -5.7, 2.7, -0.1, 0xecc58f);
  addDesk(scene, -3.55, 5.95, 0, 0xadd2d5);
  addDesk(scene, 4.65, 2.7, 0, 0xaec4e9);
  addDesk(scene, 7.15, 5.95, 0, 0xe9bbc4);
  const rug = mat(0xf2d7d7);
  box(scene, rug, -6, 0.06, 5.25, 2.25, 0.025, 0.65);
  box(scene, mat(0xdce9f5), 5.05, 0.06, 5.4, 2.4, 0.025, 0.65);
  extras.forEach((person) => addDesk(scene, person.x + 0.7, person.z + 0.8, 0, 0x9ccac6));

  const nodes = new Map();
  people.forEach((person) => {
    const figure = addCharacter(scene, person);
    figure.userData.agentId = person.id;
    const haloMaterial = new THREE.MeshBasicMaterial({
      color: 0xb9b7b0,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
    });
    const halo = new THREE.Mesh(new THREE.TorusGeometry(0.72, 0.045, 6, 32), haloMaterial);
    halo.rotation.x = Math.PI / 2;
    halo.position.set(person.x, 0.1, person.z);
    scene.add(halo);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'three-office__agent';
    button.addEventListener('click', () => onSelect?.(person.id));
    const dot = document.createElement('span');
    dot.className = 'three-office__dot';
    const label = document.createElement('span');
    label.className = 'three-office__agent-name';
    button.append(dot, label);
    overlay.append(button);
    nodes.set(person.id, {
      person,
      figure,
      halo,
      button,
      label,
      name: person.id,
      targetX: person.x,
      targetZ: person.z,
      transit: null,
    });
  });
  const roomLabels = rooms.map((room) => {
    const element = document.createElement('div');
    element.className = 'three-office__room-label';
    element.textContent = room.name;
    overlay.append(element);
    return { element, anchor: roomAnchors.get(room.id) };
  });
  const bubbles = Array.from({ length: 4 }, () => {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'three-office__bubble';
    const title = document.createElement('strong');
    const message = document.createElement('span');
    element.append(title, message);
    overlay.append(element);
    const bubble = { element, title, message };
    element.addEventListener('click', () => {
      if (bubble.person) onSelect?.(bubble.person.id);
    });
    return bubble;
  });

  // A single reusable document avoids allocations during animation.
  const documentParcel = new THREE.Group();
  box(documentParcel, mat(0xfffaf0), 0, 0, 0, 0.65, 0.08, 0.85);
  box(documentParcel, mat(0x79b4a0), 0, 0.05, -0.18, 0.42, 0.025, 0.08);
  box(documentParcel, mat(0xc5d7ce), 0, 0.05, 0.03, 0.42, 0.025, 0.05);
  scene.add(documentParcel);
  documentParcel.visible = false;
  let delivery = null;
  let previousWorker = null;
  let lastAgents = [];
  let selectedId = 'commander';
  let motion = true;
  let connected = true;
  let frame = 0;
  let disposed = false;
  let lost = false;
  let inView = true;
  const hasWorkingAgent = () =>
    connected && lastAgents.some((agent) => nodes.has(agent.id) && agent.status === 'working');
  const shouldAnimate = () =>
    !disposed &&
    !lost &&
    rendererReady &&
    motion &&
    !document.hidden &&
    inView &&
    hasWorkingAgent();
  function showFallback() {
    if (disposed) return;
    lost = true;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    host.classList.add('is-unavailable');
    engine.textContent = '担当者一覧';
    host.dataset.engine = 'list';
    if (!fallback) {
      fallback = document.createElement('div');
      fallback.className = 'three-office__fallback';
      const notice = document.createElement('p');
      notice.textContent = 'この環境では3D表示を利用できません。担当者を一覧から選べます。';
      const list = document.createElement('div');
      list.className = 'three-office__fallback-list';
      fallback.append(notice, list);
      host.append(fallback);
    }
    const list = fallback.querySelector('.three-office__fallback-list');
    list.replaceChildren();
    for (const node of nodes.values()) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'three-office__fallback-agent';
      button.dataset.status = node.button.dataset.status || 'unknown';
      button.setAttribute('aria-pressed', node.button.getAttribute('aria-pressed') || 'false');
      button.textContent = node.button.title || node.name;
      button.addEventListener('click', () => onSelect?.(node.person.id));
      list.append(button);
    }
  }
  const origin = new THREE.Vector3();
  const project = (point) => {
    origin.copy(point).project(camera);
    return { x: (origin.x + 1) * 50, y: (1 - origin.y) * 50 };
  };
  const place = (element, point) => {
    const { x, y } = project(point);
    element.style.left = `${x}%`;
    element.style.top = `${y}%`;
  };
  const overlayPoint = new THREE.Vector3();
  function placeAgents() {
    nodes.forEach(({ figure, button }) => {
      place(button, overlayPoint.set(figure.position.x, 2.48, figure.position.z));
    });
    bubbles.forEach((bubble) => {
      if (!bubble.person) return;
      const figure = nodes.get(bubble.person.id)?.figure;
      if (figure)
        place(bubble.element, overlayPoint.set(figure.position.x, 3.25, figure.position.z));
    });
  }

  function layout() {
    const bounds = host.getBoundingClientRect();
    const width = Math.max(1, bounds.width);
    const height = Math.max(1, bounds.height);
    const aspect = width / height;
    const viewHeight = extras.length ? Math.max(29, 39 / aspect) : Math.max(21.5, 30.5 / aspect);
    camera.left = (-viewHeight * aspect) / 2;
    camera.right = (viewHeight * aspect) / 2;
    camera.top = viewHeight / 2;
    camera.bottom = -viewHeight / 2;
    camera.near = 0.1;
    camera.far = 100;
    camera.updateProjectionMatrix();
    if (rendererReady) renderer.setSize(width, height, false);
    placeAgents();
    roomLabels.forEach(({ element, anchor }) => place(element, anchor));
    render();
  }

  function render() {
    if (!disposed && !lost && rendererReady) {
      try {
        renderer.render(scene, camera);
      } catch {
        showFallback();
      }
    }
  }

  function tick(timestamp) {
    frame = 0;
    if (!shouldAnimate()) return;
    for (const node of nodes.values()) {
      const { person, figure, halo } = node;
      if (node.transit) {
        const transit = node.transit;
        const progress = Math.min(1, (timestamp - transit.startedAt) / TRANSIT_DURATION);
        const eased = progress * progress * (3 - 2 * progress);
        figure.position.x = transit.fromX + (transit.toX - transit.fromX) * eased;
        figure.position.z = transit.fromZ + (transit.toZ - transit.fromZ) * eased;
        if (progress >= 1) node.transit = null;
      }
      halo.position.x = figure.position.x;
      halo.position.z = figure.position.z;
      const current = lastAgents.find((agent) => agent.id === person.id);
      const working = connected && current?.status === 'working';
      const t = timestamp / 1000;
      const phase = t * 7 + person.x;
      const walking = Boolean(node.transit);
      const celebrating = connected && node.celebrateUntil > timestamp;
      const active = working || walking;
      const { arms, feet } = figure.userData.limbs;
      figure.position.y = celebrating
        ? Math.abs(Math.sin((node.celebrateUntil - timestamp) * 0.006)) * 0.55
        : active
          ? Math.abs(Math.sin(phase)) * 0.13
          : 0;
      figure.scale.y = 1;
      figure.rotation.z = active ? Math.sin(phase * 0.5) * 0.07 : 0;
      arms.forEach((arm, index) => {
        const side = index === 0 ? -1 : 1;
        arm.rotation.z = celebrating ? side * 2.3 : side * 0.35;
        arm.rotation.x = active ? Math.sin(phase + index * Math.PI) * 0.85 : 0;
      });
      feet.forEach((foot, index) => {
        foot.position.z = 0.14 + (active ? Math.sin(phase + index * Math.PI) * 0.16 : 0);
      });
      halo.material.opacity = working ? 0.45 + Math.sin(timestamp * 0.004) * 0.12 : 0.3;
    }
    if (delivery) {
      const progress = Math.min(1, (timestamp - delivery.startedAt) / 1600);
      documentParcel.position.lerpVectors(delivery.from, delivery.to, progress);
      documentParcel.position.y += Math.sin(progress * Math.PI) * 2.5;
      documentParcel.rotation.y = progress * Math.PI * 2;
      if (progress === 1) {
        delivery = null;
        documentParcel.visible = false;
      }
    }
    placeAgents();
    render();
    if (shouldAnimate()) frame = requestAnimationFrame(tick);
  }

  function startMotion() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    host.dataset.motion = shouldAnimate() ? 'active' : 'still';
    if (shouldAnimate()) frame = requestAnimationFrame(tick);
    else {
      delivery = null;
      documentParcel.visible = false;
      nodes.forEach((node) => {
        const { figure, halo } = node;
        node.transit = null;
        node.celebrateUntil = 0;
        figure.position.x = node.targetX;
        figure.position.z = node.targetZ;
        figure.position.y = 0;
        halo.position.x = node.targetX;
        halo.position.z = node.targetZ;
        halo.material.opacity = 0.3;
        figure.rotation.z = 0;
        figure.scale.y = 1;
        figure.userData.limbs.arms.forEach((arm, index) => {
          arm.rotation.x = 0;
          arm.rotation.z = (index === 0 ? -1 : 1) * 0.35;
        });
        figure.userData.limbs.feet.forEach((foot) => {
          foot.position.z = 0.14;
        });
      });
      placeAgents();
      render();
    }
  }

  function update(agents = [], options = {}) {
    if (disposed) return;
    lastAgents = Array.isArray(agents) ? agents : [];
    selectedId = options.selectedId || selectedId;
    motion = options.motion !== false;
    connected = options.connected !== false;
    const byId = new Map(lastAgents.map((agent) => [agent.id, agent]));
    const worker = lastAgents.find((agent) => agent.status === 'working')?.id;
    if (!motion || !connected) {
      delivery = null;
      documentParcel.visible = false;
    } else if (worker && previousWorker && worker !== previousWorker && nodes.has(worker)) {
      const source = nodes.get(previousWorker);
      if (source && byId.get(previousWorker)?.status === 'done') {
        delivery = {
          from: source.figure.position.clone().setY(2.5),
          to: nodes.get(worker).figure.position.clone().setY(2.5),
          startedAt: performance.now(),
        };
        documentParcel.visible = true;
      }
    }
    if (worker) previousWorker = worker;
    const consultingRoleId =
      connected && options.consultingRoleId !== 'commander' && nodes.has(options.consultingRoleId)
        ? options.consultingRoleId
        : null;
    nodes.forEach((node, id) => {
      const { person, figure, halo, button, label } = node;
      const target = id === consultingRoleId ? CONSULTATION_POSITION : person;
      if (node.targetX !== target.x || node.targetZ !== target.z) {
        node.targetX = target.x;
        node.targetZ = target.z;
        node.transit =
          motion && hasWorkingAgent()
            ? {
                fromX: figure.position.x,
                fromZ: figure.position.z,
                toX: target.x,
                toZ: target.z,
                startedAt: performance.now(),
              }
            : null;
      }
      if (!motion || !hasWorkingAgent()) {
        node.transit = null;
        figure.position.x = target.x;
        figure.position.z = target.z;
        halo.position.x = target.x;
        halo.position.z = target.z;
      }
      const agent = byId.get(id) || {};
      if (
        node.previousStatus === 'working' &&
        agent.status === 'done' &&
        motion &&
        connected &&
        hasWorkingAgent()
      )
        node.celebrateUntil = performance.now() + 2200;
      node.previousStatus = agent.status;
      const state = statusFor(agent.status || 'idle', connected);
      const name = shorten(agent.name || id, 20);
      label.textContent = name;
      button.dataset.status = state.className;
      button.classList.toggle('is-selected', id === selectedId);
      button.setAttribute('aria-pressed', String(id === selectedId));
      button.setAttribute('aria-label', `${name}、${state.label}。詳細を表示`);
      button.title = `${name} · ${state.label}`;
      halo.material.color.setHex(state.color);
      halo.visible = state.className !== 'skipped';
      node.name = name;
    });
    // One selected bubble plus one active teammate per other room gives status context without a cloud of text.
    const candidates = people
      .filter((person) => {
        const value = byId.get(person.id)?.status;
        return connected && (value === 'working' || value === 'blocked');
      })
      .sort((a, b) => {
        const rank = { working: 0, blocked: 1, done: 2 };
        return rank[byId.get(a.id)?.status] - rank[byId.get(b.id)?.status];
      });
    const chosen = [];
    const selected = people.find((person) => person.id === selectedId);
    if (selected) chosen.push(selected);
    const usedRooms = new Set(selected ? [selected.room] : []);
    for (const person of candidates) {
      if (chosen.length >= 4) break;
      if (usedRooms.has(person.room) || person.id === selectedId) continue;
      chosen.push(person);
      usedRooms.add(person.room);
    }
    bubbles.forEach((bubble, index) => {
      const person = chosen[index];
      bubble.person = person;
      bubble.element.hidden = !person;
      if (!person) return;
      const agent = byId.get(person.id) || {};
      const state = statusFor(agent.status || 'idle', connected);
      bubble.element.dataset.status = state.className;
      bubble.element.classList.toggle('is-selected', person.id === selectedId);
      bubble.title.textContent = `${nodes.get(person.id).name} · ${state.label}`;
      const message = shorten(agent.message, person.id === selectedId ? 76 : 38);
      bubble.message.textContent =
        message || (state.className === 'working' ? '作業を進めています' : state.label);
      bubble.element.setAttribute(
        'aria-label',
        `${nodes.get(person.id).name}、${state.label}。詳細を表示`,
      );
    });
    placeAgents();
    startMotion();
    if (lost) showFallback();
  }

  const resizeObserver = new ResizeObserver(layout);
  resizeObserver.observe(host);
  const visibilityObserver =
    typeof IntersectionObserver === 'undefined'
      ? null
      : new IntersectionObserver(
          (entries) => {
            inView = entries[0]?.isIntersecting ?? true;
            startMotion();
          },
          { threshold: 0.01 },
        );
  visibilityObserver?.observe(host);
  const onVisibility = () => startMotion();
  const onLost = (event) => {
    event?.preventDefault?.();
    showFallback();
  };
  const onRestored = () => {
    lost = false;
    host.classList.remove('is-unavailable');
    fallback?.remove();
    fallback = null;
    engine.textContent = renderer?.backend?.isWebGPUBackend ? 'WebGPUで表示中' : 'WebGL2で表示中';
    host.dataset.engine = renderer?.backend?.isWebGPUBackend ? 'webgpu' : 'webgl2';
    layout();
    startMotion();
  };
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const selectCharacter = (event) => {
    if (lost || disposed) return;
    if (!rendererReady) return;
    const rect = renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
    let hit = raycaster.intersectObjects(
      [...nodes.values()].map((node) => node.figure),
      true,
    )[0]?.object;
    while (hit && !hit.userData.agentId) hit = hit.parent;
    if (hit?.userData.agentId) onSelect?.(hit.userData.agentId);
  };
  document.addEventListener('visibilitychange', onVisibility);
  void (async () => {
    try {
      renderer = new THREE.WebGPURenderer({ antialias: true, alpha: true, forceWebGL });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.8));
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFShadowMap;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.onDeviceLost = showFallback;
      canvasArea.append(renderer.domElement);
      renderer.domElement.addEventListener('click', selectCharacter);
      renderer.domElement.addEventListener('webglcontextlost', onLost);
      renderer.domElement.addEventListener('webglcontextrestored', onRestored);
      await renderer.init();
      if (disposed) {
        await renderer.dispose();
        return;
      }
      if (!renderer.backend?.isWebGPUBackend && !renderer.backend?.isWebGLBackend)
        throw new Error('No supported renderer backend');
      rendererReady = true;
      engine.textContent = renderer.backend.isWebGPUBackend ? 'WebGPUで表示中' : 'WebGL2で表示中';
      host.dataset.engine = renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2';
      layout();
      startMotion();
    } catch {
      if (renderer) void renderer.dispose();
      if (!disposed) showFallback();
    }
  })();
  layout();
  update([]);

  return {
    update,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      visibilityObserver?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      renderer?.domElement.removeEventListener('click', selectCharacter);
      renderer?.domElement.removeEventListener('webglcontextlost', onLost);
      renderer?.domElement.removeEventListener('webglcontextrestored', onRestored);
      scene.traverse((object) => {
        if (
          object.geometry &&
          ![sphereGeometry, boxGeometry, cylinderGeometry].includes(object.geometry)
        )
          object.geometry.dispose();
        if (object.material) {
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material) => material.dispose());
        }
      });
      if (rendererReady) void renderer.dispose();
      geometryUsers -= 1;
      if (geometryUsers === 0) {
        sphereGeometry.dispose();
        boxGeometry.dispose();
        cylinderGeometry.dispose();
        sharedDisposed = true;
      }
      host.remove();
    },
  };
}
