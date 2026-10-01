const canvas = document.querySelector('#scene');
const ctx = canvas.getContext('2d');
const settingsWindow = document.querySelector('#settings-backdrop');
const settingControls = {
  radius: document.querySelector('#size-slider'),
  connect: document.querySelector('#connect-slider'),
  release: document.querySelector('#release-slider'),
};
const settingOutputs = {
  radius: document.querySelector('#size-value'),
  connect: document.querySelector('#connect-value'),
  release: document.querySelector('#release-value'),
};

const palette = [
  { light: '#8cceff', base: '#4b9ee5', dark: '#285387', outline: '#153b68' },
  { light: '#ffc0df', base: '#ef70ad', dark: '#98436d', outline: '#6f294c' },
];
const settings = { radius: .125, connectGap: .065, releaseGap: .271 };

// This layout admits an eight-ball path with the original attachment threshold.
// Persistent glue adds history to the connections as the cube is turned.
const layout = [
  [.2486, -.1477, .2356], [-.3885, .2655, -.5809],
  [.1314, .4323, .2413], [.3308, -.4973, -.184],
  [.7742, -.661, .127], [-.2088, -.156, -.0814],
  [.8644, -.1971, .4314], [-.2558, .5943, -.1563],
  [.2203, -.048, .8728],
];
const pinkLayout = [
  [-.4937, -.3721, .3407], [-.8639, -.087, -.0608],
  [.3788, -.8405, -.0602], [-.1271, -.468, -.4955],
];
const levelStart = { yaw: -2.3038346126, pitch: .5759586532 };
// Pink solution: yaw -1.3264502315, pitch -.5585053606.
// At default settings all three neighboring gaps are .05: attach at .065,
// release at .271. The four balls form one unbranched path.

function createLevelBalls() {
  const layoutExtent = Math.max(...[...layout, ...pinkLayout].flat().map(Math.abs));
  const fit = Math.min(1, (1 - settings.radius) / layoutExtent);
  return [
    ...layout.map(point => ({ position: point, colorIndex: 0 })),
    ...pinkLayout.map(point => ({ position: point, colorIndex: 1 })),
  ].map(ball => ({
    ...ball,
    position: ball.position.map(value => value * fit),
  }));
}

let balls = createLevelBalls();

const corners = [];
for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) corners.push([x, y, z]);
const edges = [];
for (let a = 0; a < corners.length; a++) for (let b = a + 1; b < corners.length; b++) {
  if (corners[a].filter((value, axis) => value !== corners[b][axis]).length === 1) edges.push([a, b]);
}

let width = 0, height = 0, dpr = 1;
let dragging = false, lastX = 0, lastY = 0;
let previousConnections = new Set();
let pulses = balls.map(() => []);
let animationFrame = null;
let draftSettings = { ...settings };

function pulseAt(index, now) {
  pulses[index] = pulses[index].filter(pulse => now - pulse.started < 1400);
  const displacement = pulses[index].reduce((sum, pulse) => {
    const time = (now - pulse.started) / 1000;
    return sum + pulse.amplitude * Math.exp(-4.8 * time) * Math.sin(26 * time);
  }, 0);
  return Math.max(-.18, Math.min(.18, displacement));
}

function multiply(a, b) {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function axisRotation(axis, angle) {
  const half = angle / 2, sine = Math.sin(half);
  return [axis[0] * sine, axis[1] * sine, axis[2] * sine, Math.cos(half)];
}

let orientation = [0, 0, 0, 1];

function resize() {
  width = innerWidth;
  height = innerHeight;
  dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

function rotateWith([x, y, z], rotation) {
  const [qx, qy, qz, qw] = rotation;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [
    x + qw * tx + qy * tz - qz * ty,
    y + qw * ty + qz * tx - qx * tz,
    z + qw * tz + qx * ty - qy * tx,
  ];
}

function rotate(position) {
  return rotateWith(position, orientation);
}

function chooseStartingOrientation() {
  return multiply(axisRotation([1, 0, 0], levelStart.pitch), axisRotation([0, 1, 0], levelStart.yaw));
}

orientation = chooseStartingOrientation();

function project(position, scale) {
  const [x, y, z] = rotate(position);
  return { x: width / 2 + x * scale, y: height / 2 - y * scale, z };
}

function draw(now = performance.now()) {
  ctx.clearRect(0, 0, width, height);
  const scale = Math.min(width * .36, height * .34, 240);
  const projectedCorners = corners.map(corner => project(corner, scale));
  const projectedBalls = balls.map((ball, index) => ({
    ...project(ball.position, scale), index, colorIndex: ball.colorIndex,
    radius: scale * settings.radius, baseRadius: scale * settings.radius,
    active: false,
  }));
  const connections = [];
  const connectionKeys = new Set();

  // Compare the gap between projected disc edges, in screen pixels. Depth and
  // real-world distance have no part in deciding whether two balls connect.
  const gapLimit = scale * settings.connectGap;
  const releaseGapLimit = scale * settings.releaseGap;
  for (let i = 0; i < projectedBalls.length; i++) for (let j = i + 1; j < projectedBalls.length; j++) {
    const a = projectedBalls[i], b = projectedBalls[j];
    if (a.colorIndex !== b.colorIndex) continue;
    const key = `${i}:${j}`;
    const gap = Math.hypot(a.x - b.x, a.y - b.y) - a.radius - b.radius;
    const threshold = previousConnections.has(key) ? releaseGapLimit : gapLimit;
    if (gap <= threshold) {
      a.active = b.active = true;
      connections.push([a, b]);
      connectionKeys.add(key);
    }
  }
  // Detect changes using the resting radii. Visual spring motion must never
  // create or break a logical connection by itself.
  const impulses = new Map();
  for (const key of new Set([...previousConnections, ...connectionKeys])) {
    const before = previousConnections.has(key), after = connectionKeys.has(key);
    if (before === after) continue;
    for (const index of key.split(':').map(Number)) {
      impulses.set(index, (impulses.get(index) || 0) + (after ? 1 : -1));
    }
  }
  for (const [index, impulse] of impulses) {
    if (impulse) pulses[index].push({ started: now, amplitude: impulse > 0 ? .13 : -.16 });
  }
  previousConnections = connectionKeys;
  for (const ball of projectedBalls) {
    ball.pulse = pulseAt(ball.index, now);
    ball.radius = ball.baseRadius * (1 + ball.pulse);
  }
  // Rear edges are faint; front edges remain legible over the balls.
  for (const front of [false, true]) {
    ctx.lineWidth = front ? 3.3 : 2.4;
    ctx.strokeStyle = front ? '#aaa4a580' : '#ccc6c180';
    for (const [a, b] of edges) {
      const p = projectedCorners[a], q = projectedCorners[b];
      if (((p.z + q.z) / 2 >= 0) !== front) continue;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
    }
    if (!front) {
      drawJelly(projectedBalls, connections, releaseGapLimit);
    }
  }
  if (pulses.some(events => events.length) && animationFrame === null) {
    animationFrame = requestAnimationFrame(time => {
      animationFrame = null;
      draw(time);
    });
  }
}

function jellyBridge(a, b, gapLimit) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const distance = Math.hypot(dx, dy);
  const r = Math.min(a.radius, b.radius);
  if (distance < r * .25) return null;
  const strength = Math.max(0, Math.min(1, (2 * r + gapLimit - distance) / (gapLimit + r)));
  const overlapAngle = Math.acos(Math.min(1, distance / (2 * r)));
  const angle = Math.min(1.48, Math.max(.18 + strength * 1.1, overlapAngle + .18));
  const x = r * Math.cos(angle), h = r * Math.sin(angle);
  const neck = Math.min(h * .88, r * (.015 + .72 * Math.sqrt(strength)));
  const span = Math.max(.01, distance / 2 - x);
  const handle = Math.min(span * .65, Math.max(.01, h - neck) / Math.max(.05, Math.cos(angle)));
  const ux = dx / distance, uy = dy / distance;
  const point = (px, py) => [a.x + ux * px - uy * py, a.y + uy * px + ux * py];
  const path = new Path2D();
  const curve = (x1, y1, x2, y2, x3, y3) => path.bezierCurveTo(...point(x1, y1), ...point(x2, y2), ...point(x3, y3));
  const tx = Math.sin(angle) * handle, ty = Math.cos(angle) * handle;
  path.moveTo(...point(x, -h));
  curve(x + tx, -h + ty, distance / 2 - span * .4, -neck, distance / 2, -neck);
  curve(distance / 2 + span * .4, -neck, distance - x - tx, -h + ty, distance - x, -h);
  path.lineTo(...point(distance - x, h));
  curve(distance - x - tx, h - ty, distance / 2 + span * .4, neck, distance / 2, neck);
  curve(distance / 2 - span * .4, neck, x + tx, h - ty, x, h);
  path.closePath();
  return path;
}

function drawJelly(projectedBalls, connections, gapLimit) {
  const active = projectedBalls.filter(ball => ball.active);
  for (const colorIndex of new Set(active.map(ball => ball.colorIndex))) {
    const group = active.filter(ball => ball.colorIndex === colorIndex);
    const groupConnections = connections.filter(([a]) => a.colorIndex === colorIndex);
    const groupColor = palette[colorIndex];
    const shape = new Path2D();
    for (const ball of group) {
      shape.moveTo(ball.x + ball.radius, ball.y);
      shape.arc(ball.x, ball.y, ball.radius, 0, Math.PI * 2);
      shape.closePath();
    }
    for (const [a, b] of groupConnections) {
      const bridge = jellyBridge(a, b, gapLimit);
      if (bridge) shape.addPath(bridge);
    }
    // Paint the outline first, then cover its interior with the filled union.
    // This leaves only the outside contour without a full-screen scratch canvas.
    ctx.strokeStyle = groupColor.outline;
    ctx.lineWidth = Math.max(9.24, group[0].baseRadius * .315);
    ctx.lineJoin = 'round';
    ctx.stroke(shape);
    ctx.fillStyle = groupColor.base;
    ctx.fill(shape);
    ctx.save();
    ctx.clip(shape);
    for (const ball of group.sort((a, b) => a.z - b.z)) {
      const r = ball.radius;
      const glow = ctx.createRadialGradient(ball.x - r * .28, ball.y - r * .35, 0, ball.x, ball.y, r * 1.12);
      glow.addColorStop(0, `${groupColor.light}dd`);
      glow.addColorStop(.42, `${groupColor.light}77`);
      glow.addColorStop(1, `${groupColor.light}00`);
      ctx.fillStyle = glow;
      ctx.fillRect(ball.x - r * 1.4, ball.y - r * 1.5, r * 2.8, r * 3);
      drawShine(ball);
    }
    ctx.restore();
  }
  for (const ball of projectedBalls.filter(ball => !ball.active).sort((a, b) => a.z - b.z)) drawBall(ball);
}

function drawBall(ball) {
  const r = ball.radius;
  const ballColor = palette[ball.colorIndex];
  const gradient = ctx.createRadialGradient(ball.x - r * .35, ball.y - r * .42, r * .07,
    ball.x + r * .20, ball.y + r * .25, r * 1.3);
  gradient.addColorStop(0, ballColor.light);
  gradient.addColorStop(.48, ballColor.base);
  gradient.addColorStop(1, ballColor.dark);
  ctx.beginPath(); ctx.arc(ball.x, ball.y, r, 0, Math.PI * 2);
  ctx.fillStyle = gradient; ctx.fill();
  drawShine(ball);
}

function drawShine(ball) {
  const r = ball.radius;
  ctx.beginPath();
  ctx.ellipse(ball.x - r * .35, ball.y - r * .45, r * .115, r * .055, -.6, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffffbb'; ctx.fill();
}

canvas.addEventListener('pointerdown', event => {
  dragging = true; lastX = event.clientX; lastY = event.clientY;
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener('pointermove', event => {
  if (!dragging) return;
  const dx = (event.clientX - lastX) * .007;
  const dy = (event.clientY - lastY) * .007;
  // Apply both rotations around screen axes, so horizontal motion keeps the
  // same direction even after the cube has been turned upside down.
  orientation = multiply(axisRotation([1, 0, 0], dy),
    multiply(axisRotation([0, 1, 0], dx), orientation));
  const length = Math.hypot(...orientation);
  orientation = orientation.map(value => value / length);
  lastX = event.clientX; lastY = event.clientY;
  draw();
});
canvas.addEventListener('pointerup', () => { dragging = false; });
canvas.addEventListener('pointercancel', () => { dragging = false; });

function showSettingValues() {
  settingOutputs.radius.value = `${(draftSettings.radius * 100).toFixed(1)}%`;
  settingOutputs.connect.value = `${(draftSettings.connectGap * 100).toFixed(1)}%`;
  settingOutputs.release.value = `${(draftSettings.releaseGap * 100).toFixed(1)}%`;
}

function loadSettingControls(source) {
  settingControls.radius.value = source.radius * 100;
  settingControls.connect.value = source.connectGap * 100;
  settingControls.release.value = source.releaseGap * 100;
  showSettingValues();
}

function openSettings() {
  draftSettings = { ...settings };
  loadSettingControls(draftSettings);
  settingsWindow.classList.add('open');
  document.querySelector('#close-settings').focus();
}

function closeSettings() {
  settingsWindow.classList.remove('open');
  document.querySelector('#open-settings').focus();
}

document.querySelector('#open-settings').addEventListener('click', openSettings);
document.querySelector('#close-settings').addEventListener('click', closeSettings);
settingsWindow.addEventListener('click', event => {
  if (event.target === settingsWindow) closeSettings();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && settingsWindow.classList.contains('open')) closeSettings();
});

for (const [key, control] of Object.entries(settingControls)) {
  control.addEventListener('input', () => {
    const value = Number(control.value) / 100;
    if (key === 'radius') draftSettings.radius = value;
    if (key === 'connect') {
      draftSettings.connectGap = value;
      if (draftSettings.releaseGap < value) draftSettings.releaseGap = value;
    }
    if (key === 'release') {
      draftSettings.releaseGap = value;
      if (draftSettings.connectGap > value) draftSettings.connectGap = value;
    }
    loadSettingControls(draftSettings);
  });
}

document.querySelector('#reset-game').addEventListener('click', () => {
  Object.assign(settings, draftSettings);
  balls = createLevelBalls();
  pulses = balls.map(() => []);
  previousConnections.clear();
  if (animationFrame !== null) cancelAnimationFrame(animationFrame);
  animationFrame = null;
  orientation = chooseStartingOrientation();
  closeSettings();
  draw();
});

loadSettingControls(settings);
addEventListener('resize', resize);
resize();
