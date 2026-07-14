// ==================================================
// 表示地域の設定画面
// 選択した都道府県IDのリストを localStorage に保存し、
// main.js側はその設定に応じて表示する通報を絞り込む。
// (未設定 = 絞り込みなし = 従来通り全国分を表示)
// ==================================================
const STORAGE_KEY = 'qzss_target_prefectures';

function loadTargetIds() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    return Array.isArray(arr) && arr.length ? new Set(arr) : null;
  } catch (e) {
    return null;
  }
}

async function main() {
  const grid = document.getElementById('pref_grid');
  const showAllCheckbox = document.getElementById('show_all_checkbox');
  const saveBtn = document.getElementById('save_btn');

  const res = await fetch('./data/prefectures.geojson');
  const geojson = await res.json();
  const prefectures = geojson.features
    .map((f) => f.properties)
    .sort((a, b) => a.id - b.id);

  const targetIds = loadTargetIds();
  showAllCheckbox.checked = !targetIds;

  for (const pref of prefectures) {
    const label = document.createElement('label');
    label.className = 'pref-item';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = String(pref.id);
    checkbox.checked = !!(targetIds && targetIds.has(pref.id));
    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(pref.name));
    grid.appendChild(label);
  }

  function setGridEnabled(enabled) {
    grid.style.opacity = enabled ? '1' : '0.4';
    for (const checkbox of grid.querySelectorAll('input[type=checkbox]')) {
      checkbox.disabled = !enabled;
    }
  }
  setGridEnabled(!showAllCheckbox.checked);
  showAllCheckbox.addEventListener('change', () => setGridEnabled(!showAllCheckbox.checked));

  saveBtn.addEventListener('click', () => {
    if (showAllCheckbox.checked) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      const selected = [...grid.querySelectorAll('input[type=checkbox]:checked')].map((el) => Number(el.value));
      if (selected.length) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(selected));
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
    }
    saveBtn.textContent = '保存しました ✓';
    saveBtn.classList.add('saved');
    setTimeout(() => {
      saveBtn.textContent = '保存する';
      saveBtn.classList.remove('saved');
    }, 1500);
  });
}

main();
