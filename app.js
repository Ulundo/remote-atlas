const el = id => document.getElementById(id);
const node = (tag, value, className) => {
  const element = document.createElement(tag);
  if (value) element.textContent = value;
  if (className) element.className = className;
  return element;
};
const button = (label, action, pressed) => {
  const element = node('button', label);
  element.type = 'button';
  element.addEventListener('click', action);
  if (pressed !== undefined) element.setAttribute('aria-pressed', String(pressed));
  return element;
};
const read = async name => {
  const response = await fetch(`./data/${name}.json`);
  if (!response.ok) throw new Error(name);
  return response.json();
};
const normalize = value => value.toLowerCase().replaceAll('ё', 'е').trim();
const dayName = day => day === null ? 'Пролог' : `День ${day}`;
const precision = { exact: 'Названное место', inferred: 'Определено по контексту', approximate: 'Приблизительно' };
const placeKind = { real: 'Реальный топоним', fictional: 'Вымышленный топоним', unknown: 'Координаты неизвестны', inferred: 'Идентификация по контексту', area: 'Ориентир региона' };
const routeKind = { air: 'Дуга большого круга', schematic: 'Схематичный путь', road: 'Восстановлено по дорогам', sea: 'Восстановлено по описанию', walk: 'Восстановлено по описанию', direction: 'Известно направление' };
const longitude = (lon, near = 110) => lon + Math.round((near - lon) / 360) * 360;
function mapCenterLongitude(coordinates) {
  const sorted = coordinates.map(([, lon]) => (lon + 360) % 360).sort((a, b) => a - b);
  if (!sorted.length) return 110;
  let widest = 0;
  let start = sorted[0];
  sorted.forEach((lon, index) => {
    const next = sorted[index + 1] ?? sorted[0] + 360;
    if (next - lon > widest) {
      widest = next - lon;
      start = next;
    }
  });
  return widest > 180 ? longitude(start + (360 - widest) / 2) : 110;
}

// Spherical interpolation follows the shortest great-circle arc. Keep it
// continuous across the date line so Leaflet never draws a line around Earth.
function greatCircle(start, end) {
  const radians = Math.PI / 180;
  const vector = ([lat, lon]) => [
    Math.cos(lat * radians) * Math.cos(lon * radians),
    Math.cos(lat * radians) * Math.sin(lon * radians),
    Math.sin(lat * radians),
  ];
  const a = vector(start);
  const b = vector(end);
  const angle = Math.acos(Math.max(-1, Math.min(1, a.reduce((sum, v, i) => sum + v * b[i], 0))));
  if (angle < 1e-8) return [start, end];
  const points = [start];
  for (let i = 1; i <= 48; i++) {
    const t = i / 48;
    const p = a.map((v, index) => v * Math.sin((1 - t) * angle) + b[index] * Math.sin(t * angle));
    const lat = Math.atan2(p[2], Math.hypot(p[0], p[1])) / radians;
    const lon = Math.atan2(p[1], p[0]) / radians;
    points.push([lat, longitude(lon, points.at(-1)[1])]);
  }
  return points;
}

async function start() {
  const [people, places, rawScenes, rawRoutes, chronology] = await Promise.all(
    ['characters', 'places', 'scenes', 'routes', 'chronology'].map(read),
  );
  const { last_day: lastDay, days, gaps } = chronology;
  const allowed = value => value === null || (Number.isInteger(value) && value <= lastDay && days.includes(value));
  const scenes = rawScenes.filter(scene => allowed(scene.day));
  const sceneIds = new Set(scenes.map(scene => scene.id));
  const routes = rawRoutes.filter(route => allowed(route.day) && sceneIds.has(route.scene_id));
  const routesByScene = new Map(routes.map(route => [route.scene_id, route]));
  const stops = route => [route.from_place_id, ...route.via_place_ids, route.to_place_id];
  const title = item => item.scene_id
    ? `${places[item.from_place_id].name} → ${places[item.to_place_id].name}`
    : places[item.place_id].name;
  const participants = item => item.character_ids.map(id => people[id].name).join(', ');
  const map = window.L ? L.map('map', { zoomControl: false, zoomSnap: .25 }).setView([31, 110], 2) : null;
  const layers = map && L.featureGroup().addTo(map);
  const arrows = map && L.layerGroup().addTo(map);
  if (map) {
    const arrowPane = map.createPane('route-arrows');
    arrowPane.classList.add('route-arrows');
    L.control.zoom({ position: 'topright', zoomInTitle: 'Приблизить', zoomOutTitle: 'Отдалить' }).addTo(map);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
  }
  const state = { day: 'all', character: '', group: 'all', query: '' };
  let visible = [];
  let drawnRoutes = [];
  let centerLongitude = 110;
  const mapPoint = ([lat, lon]) => [lat, longitude(lon, centerLongitude)];
  let previousFocus;

  el('limit').textContent = `До начала Day ${lastDay + 1}`;
  function toggle(panel, control, open) {
    el(panel).hidden = !open;
    el(control).setAttribute('aria-expanded', String(open));
  }
  function closeDetails(restore = false) {
    if (el('detail').hidden) return;
    el('detail').hidden = true;
    if (restore && previousFocus?.isConnected) previousFocus.focus();
  }
  function details(items) {
    previousFocus = document.activeElement;
    toggle('results', 'results-button', false);
    toggle('character-panel', 'characters', false);
    el('content').replaceChildren(...items.map(card));
    el('detail').hidden = false;
    el('detail').scrollTop = 0;
    el('close').focus({ preventScroll: true });
  }
  function card(item) {
    const article = node('article');
    const heading = node('h2', title(item));
    const place = places[item.place_id];
    const route = item.scene_id ? item : routesByScene.get(item.id);
    const flags = item.scene_id
      ? [item.transport, routeKind[item.route_type], precision[item.confidence]]
      : [place.local, placeKind[place.kind], precision[item.confidence]];
    article.append(heading, node('div', [dayName(item.day), ...flags].filter(Boolean).join(' · '), 'meta'),
      node('p', item.event), node('p', participants(item), 'meta'));
    if (item.scene_id && item.via_place_ids.length) {
      article.append(node('p', `Через ${item.via_place_ids.map(id => places[id].name).join(' → ')}`));
    }
    if (item.scene_id) {
      const shape = geometry(item);
      if (!shape.length) {
        article.append(node('p', 'Для линии на карте недостаточно координат.', 'meta'));
      } else if (map && visible.includes(item)) {
        article.append(button('Приблизить маршрут', () => {
          closeDetails();
          fitBounds(L.latLngBounds(shape.flat()), 16);
          el('fit').focus({ preventScroll: true });
        }));
      }
    }
    if (route && !item.scene_id) {
      article.append(button(title(route), () => details([route])));
    }
    if (!item.scene_id) {
      const followsCharacter = other => other.character_ids.some(id =>
        state.character ? id === state.character : item.character_ids.includes(id));
      const index = scenes.indexOf(item);
      const before = scenes.slice(0, index).findLast(followsCharacter);
      const after = scenes.slice(index + 1).find(followsCharacter);
      for (const [label, neighbor] of [['До этого', before], ['Дальше', after]]) {
        if (neighbor) {
          const link = button(`${label} · ${title(neighbor)}`, () => details([neighbor]));
          link.className = 'link';
          article.append(link);
        }
      }
    }
    article.append(node('p', item.source_note, 'source'));
    return article;
  }

  function geometry(route) {
    if (route.geometry?.length > 1) return [route.geometry.map(mapPoint)];
    const points = stops(route).map(id => places[id].coords);
    if (route.route_type === 'air' && points.every(Boolean) && points.length === 2) {
      return [greatCircle(...points.map(mapPoint))];
    }
    const segments = [];
    let segment = [];
    for (const point of [...points, null]) {
      if (point) segment.push(mapPoint(point));
      else {
        if (segment.length > 1) segments.push(segment);
        segment = [];
      }
    }
    return segments;
  }
  function matches(item) {
    if (state.day !== 'all' && item.day !== state.day) return false;
    if (state.character && !item.character_ids.includes(state.character)) return false;
    const keys = item.scene_id ? stops(item) : [item.place_id];
    const locations = keys.flatMap(id => [places[id].name, places[id].local]);
    return state.query.split(/\s+/).every(word =>
      normalize([item.event, item.transport, participants(item), ...locations].join(' ')).includes(word));
  }
  function fit() {
    if (map) fitBounds(layers.getBounds(), 11);
  }
  function fitBounds(bounds, maxZoom) {
    if (!bounds.isValid()) return;
    map.stop();
    map.fitBounds(bounds, { padding: [42, 42], maxZoom, animate: false });
  }
  function drawArrows() {
    if (!map) return;
    arrows.clearLayers();
    const zoom = map.getZoom();
    for (const { shape, air, arrivalHeading } of drawnRoutes) {
      for (const path of shape) {
        const points = path.map(point => map.project(point, zoom));
        const lengths = points.slice(1).map((point, index) => point.distanceTo(points[index]));
        const total = lengths.reduce((sum, length) => sum + length, 0);
        if (total < 30) continue;
        const count = Math.min(12, Math.max(1, Math.floor(total / 115)));
        let index = 0;
        let covered = 0;
        for (let i = 0; i < count; i++) {
          const distance = total * (i + .62) / count;
          while (covered + lengths[index] < distance) covered += lengths[index++];
          const a = points[index];
          const delta = points[index + 1].subtract(a);
          const offset = distance - covered;
          const anchor = a.add(delta.multiplyBy(offset / lengths[index]));
          const angle = Math.atan2(delta.y, delta.x) * 180 / Math.PI;
          const icon = L.divIcon({
            className: air ? 'route-arrow air' : 'route-arrow',
            html: `<span aria-hidden="true" style="transform: rotate(${angle}deg)">➤</span>`,
            iconSize: [20, 20],
          });
          L.marker(map.unproject(anchor, zoom), {
            pane: 'route-arrows', icon, interactive: false, keyboard: false,
          }).addTo(arrows);
        }
      }
      if (Number.isFinite(arrivalHeading)) {
        const endpoint = map.project(shape.at(-1).at(-1), zoom);
        const angle = arrivalHeading - 90;
        const radians = angle * Math.PI / 180;
        const projected = endpoint.add(L.point(Math.cos(radians) * 24, Math.sin(radians) * 24));
        const icon = L.divIcon({
          className: 'route-arrow arrival-heading',
          html: `<span aria-hidden="true" style="transform: rotate(${angle}deg)">➤</span>`,
          iconSize: [22, 22],
        });
        L.marker(map.unproject(projected, zoom), {
          pane: 'route-arrows', icon, interactive: false, keyboard: false,
        }).addTo(arrows);
      }
    }
  }
  function render() {
    const selectedScenes = scenes.filter(matches);
    const selectedRoutes = routes.filter(matches);
    visible = [...selectedScenes, ...selectedRoutes].sort((a, b) => (a.day ?? -1) - (b.day ?? -1));
    renderResults();
    el('status').textContent = map
      ? `${selectedScenes.length} сцен · ${selectedRoutes.length} маршрутов`
      : 'Карта недоступна · записи доступны в списке';
    if (!layers) return;
    layers.clearLayers();
    drawnRoutes = [];
    const activePlaces = [...selectedScenes.map(scene => scene.place_id), ...selectedRoutes.flatMap(stops)];
    centerLongitude = mapCenterLongitude(activePlaces.map(id => places[id].coords).filter(Boolean));
    for (const route of selectedRoutes) {
      const shape = geometry(route);
      if (!shape.length) continue;
      drawnRoutes.push({ shape, air: route.route_type === 'air', arrivalHeading: route.arrival_heading });
      const dashed = ['schematic', 'direction'].includes(route.route_type);
      const line = L.polyline(shape, {
        weight: 5, opacity: .86, color: route.route_type === 'air' ? '#72c2ce' : '#f0cb86',
        dashArray: dashed ? '6 8' : undefined, bubblingMouseEvents: false,
      }).addTo(layers);
      line.on('click', () => details([route]));
    }
    const atPlace = new Map();
    for (const scene of selectedScenes) {
      if (!atPlace.has(scene.place_id)) atPlace.set(scene.place_id, []);
      atPlace.get(scene.place_id).push(scene);
    }
    for (const route of selectedRoutes) {
      for (const id of stops(route)) {
        if (!atPlace.has(id)) atPlace.set(id, []);
        const items = atPlace.get(id);
        if (items.every(item => item.id !== route.scene_id)) items.push(route);
      }
    }
    for (const [id, items] of atPlace) {
      const place = places[id];
      if (!place.coords) continue;
      const icon = L.divIcon({
        html: items.length > 1 ? String(items.length) : '',
        className: place.kind === 'real' ? 'pin' : 'pin approx', iconSize: [22, 22],
      });
      const marker = L.marker(mapPoint(place.coords), {
        title: place.name, alt: place.name, icon, bubblingMouseEvents: false,
      }).addTo(layers);
      marker.on('click', () => details(items));
      marker.getElement().setAttribute('aria-label', place.name);
      marker.getElement().addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        details(items);
      });
    }
    drawArrows();
  }
  function renderResults() {
    const container = el('results');
    container.replaceChildren();
    if (!visible.length) container.append(node('p', 'По этим фильтрам ничего не найдено.'));
    for (const item of visible) {
      const choice = button(title(item), () => details([item]));
      choice.append(node('small', `${dayName(item.day)} · ${item.event}`));
      container.append(choice);
    }
  }
  function selectCharacter(id) {
    state.character = id;
    el('characters').textContent = id ? people[id].name : 'Персонажи';
    el('characters').setAttribute('aria-label', id ? `Персонажи · ${people[id].name}` : 'Персонажи');
    el('characters').classList.toggle('selected', Boolean(id));
    closeDetails();
    toggle('results', 'results-button', false);
    toggle('character-panel', 'characters', false);
    characterList();
    render();
    fit();
    el('characters').focus();
  }
  function characterList() {
    const groups = [['all', 'Все'], ['main', 'Основные'], ['support', 'Второстепенные']];
    el('groups').replaceChildren(...groups.map(([id, label]) => button(label, () => {
      state.group = id;
      characterList();
      el('groups').querySelector('[aria-pressed="true"]').focus();
    }, state.group === id)));
    const ordered = Object.entries(people).sort(([, a], [, b]) => a.name.localeCompare(b.name, 'ru'));
    const roster = ordered.filter(([, person]) => state.group === 'all' || person.group === state.group);
    el('character-list').replaceChildren(button('Все персонажи', () => selectCharacter(''), !state.character),
      ...roster.map(([id, person]) => button(person.name, () => selectCharacter(id), state.character === id)));
  }
  function renderDays() {
    const nav = el('days');
    nav.replaceChildren();
    const addDay = (value, label) => {
      const control = button(label, () => {
        state.day = value;
        closeDetails();
        renderDays();
        render();
        fit();
        el('days').querySelector('[aria-pressed="true"]').focus();
      }, state.day === value);
      nav.append(control);
    };
    addDay('all', 'Все дни');
    addDay(null, 'Пролог');
    for (const day of days) {
      addDay(day, String(day));
      const gap = gaps.find(([first]) => first === day + 1);
      if (gap) {
        const [first, last] = gap;
        nav.append(node('span', `${first === last ? first : `${first}–${last}`} · без глав`, 'gap'));
      }
    }
  }
  el('search').addEventListener('input', event => {
    state.query = normalize(event.target.value);
    closeDetails();
    toggle('character-panel', 'characters', false);
    render();
    toggle('results', 'results-button', Boolean(state.query));
    if (state.query) fit();
  });
  el('search').addEventListener('keydown', event => {
    if (event.key === 'Enter') el('results').querySelector('button')?.focus();
  });
  el('characters').onclick = () => {
    closeDetails();
    toggle('results', 'results-button', false);
    toggle('character-panel', 'characters', el('character-panel').hidden);
  };
  el('results-button').onclick = () => {
    closeDetails();
    toggle('character-panel', 'characters', false);
    toggle('results', 'results-button', el('results').hidden);
    if (!el('results').hidden) el('results').querySelector('button')?.focus();
  };
  el('fit').onclick = fit;
  el('close').onclick = () => closeDetails(true);
  map?.on('click', () => closeDetails());
  map?.on('zoomend', drawArrows);
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (!el('detail').hidden) closeDetails(true);
    else if (!el('character-panel').hidden) {
      toggle('character-panel', 'characters', false);
      el('characters').focus();
    } else if (!el('results').hidden) {
      toggle('results', 'results-button', false);
      el('results-button').focus();
    }
  });
  characterList();
  renderDays();
  render();
  fit();
}
start().catch(error => {
  el('status').textContent = 'Не удалось загрузить данные атласа. Обновите страницу.';
  console.error(error);
});
