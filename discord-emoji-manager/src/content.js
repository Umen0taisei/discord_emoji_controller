// Discord Emoji Manager — content script v4

(function () {
  'use strict';

  const S_CATS    = 'dem_categories';
  const S_ASSIGNS = 'dem_assignments';
  const S_ORDER   = 'dem_order';
  const S_POS     = 'dem_panel_pos';

  let state = {
    categories:   [],
    assignments:  {},   // emojiId -> categoryId
    emojiOrder:   [],   // id[]  カスタム並び順
    emojis:       [],   // { id, name, url, guildName, unicode }
    currentCat:   'all',
    selected:     new Set(),
    sortOrder:    'custom',
    search:       '',
    panelVisible: false,
  };

  // ドラッグ中の状態（グローバル変数でシンプルに管理）
  let dragIds    = null;   // string[] | null
  let dragTarget = null;   // 'grid' | 'cat' — どこに向かっているか

  // ── ストレージ ─────────────────────────────────────────────────────────
  function loadStorage() {
    return new Promise(resolve => {
      chrome.storage.local.get([S_CATS, S_ASSIGNS, S_ORDER, S_POS], res => {
        if (res[S_CATS])    state.categories  = res[S_CATS];
        if (res[S_ASSIGNS]) state.assignments = res[S_ASSIGNS];
        if (res[S_ORDER])   state.emojiOrder  = res[S_ORDER];
        resolve(res[S_POS] || null);
      });
    });
  }
  const saveCats    = () => chrome.storage.local.set({ [S_CATS]:    state.categories  });
  const saveAssigns = () => chrome.storage.local.set({ [S_ASSIGNS]: state.assignments });
  const saveOrder   = () => chrome.storage.local.set({ [S_ORDER]:   state.emojiOrder  });
  const savePos     = (x,y) => chrome.storage.local.set({ [S_POS]: {x,y} });

  // ── Unicode絵文字一覧 ───────────────────────────────────────────────────
  const UNICODE_EMOJIS = [
    ['😀','grinning'],['😂','joy'],['🤣','rofl'],['😊','blush'],['😍','heart_eyes'],
    ['🥰','smiling_hearts'],['😎','sunglasses'],['🤔','thinking'],['😭','sob'],
    ['😅','sweat_smile'],['🥺','pleading'],['😤','triumph'],['🤯','exploding_head'],
    ['😴','sleeping'],['🤢','nauseated'],['😇','innocent'],['🥳','partying'],
    ['😈','smiling_imp'],['💀','skull'],['👻','ghost'],['🤡','clown'],
    ['👍','thumbsup'],['👎','thumbsdown'],['👏','clap'],['🙏','pray'],
    ['💪','muscle'],['🫡','saluting'],['🤌','pinched_fingers'],['🤝','handshake'],
    ['🙌','raised_hands'],['👀','eyes'],['✨','sparkles'],['🔥','fire'],
    ['💯','100'],['❤️','heart'],['💔','broken_heart'],['💕','two_hearts'],
    ['⭐','star'],['🎉','tada'],['🎮','video_game'],['🏆','trophy'],
    ['⚡','zap'],['🌙','moon'],['☀️','sunny'],['🌈','rainbow'],
    ['🐱','cat'],['🐶','dog'],['🦊','fox'],['🐸','frog'],['🐧','penguin'],
    ['🍕','pizza'],['🍣','sushi'],['☕','coffee'],['🧋','bubble_tea'],['🍜','ramen'],
    ['👈','hand_left'],['👆','hand_up'],['👉','hand_right'],['👇','hand_down'],
    ['😘','kiss'],['','ramen']
  ].map(([ch, name]) => ({
    id: 'u_' + name, name, url: ch, guildName: 'Unicode', unicode: true,
  }));

  // ── 絵文字収集 ─────────────────────────────────────────────────────────
  function collectCustomFromDOM() {
    const imgs = document.querySelectorAll(
      '[class*="emojiItem"] img, [class*="emoji-item"] img, [data-type="emoji"] img'
    );
    const result = [], seen = new Set();
    imgs.forEach(img => {
      const src = img.src || '';
      const m   = src.match(/emojis\/(\d+)/);
      if (!m) return;
      const id = m[1];
      if (seen.has(id)) return;
      seen.add(id);
      const name      = (img.alt || img.getAttribute('aria-label') || id).replace(/:/g,'');
      const guildEl   = img.closest('[class*="categorySection"]');
      const guildName = guildEl?.querySelector('[class*="categoryName"]')?.textContent?.trim() || 'カスタム';
      result.push({ id, name, url: src, guildName, unicode: false });
    });
    return result;
  }

  function mergeEmojis(list) {
    const existing = new Set(state.emojis.map(e => e.id));
    let added = false;
    list.forEach(e => {
      if (existing.has(e.id)) return;
      state.emojis.push(e);
      existing.add(e.id);
      if (!state.emojiOrder.includes(e.id)) state.emojiOrder.push(e.id);
      added = true;
    });
    return added;
  }

  function watchEmojiPicker() {
    new MutationObserver(() => {
      if (!document.querySelector('[class*="emojiPicker"]')) return;
      setTimeout(() => {
        if (mergeEmojis(collectCustomFromDOM())) {
          saveOrder();
          if (state.panelVisible) renderGrid();
        }
      }, 400);
    }).observe(document.body, { childList: true, subtree: true });
  }

  // ── UI構築 ────────────────────────────────────────────────────────────
  function buildPanel() {
    const btn = el('button', { id: 'dem-toggle-btn', title: '絵文字マネージャー' });
    btn.textContent = '⭐';
    btn.onclick = togglePanel;
    document.body.appendChild(btn);

    const panel = el('div', { id: 'dem-panel', className: 'dem-hidden' });
    panel.innerHTML = `
      <div id="dem-header">
        <span id="dem-header-title">⭐ 絵文字マネージャー</span>
        <button id="dem-close-btn">✕</button>
      </div>
      <div id="dem-toolbar">
        <input id="dem-search" type="text" placeholder="絵文字を検索...">
        <button id="dem-sort-btn">↕ カスタム順</button>
      </div>
      <div id="dem-cats"></div>
      <div id="dem-info-bar" class="dem-hidden"></div>
      <div id="dem-grid"></div>
      <div id="dem-footer">
        <span id="dem-sel-info">クリックで挿入 / ドラッグで並び替え・移動</span>
        <button class="dem-footer-btn" id="dem-move-btn">移動 ▾</button>
        <button class="dem-footer-btn dem-primary" id="dem-desel-btn">解除</button>
      </div>
      <div id="dem-move-dropdown"></div>
    `;
    document.body.appendChild(panel);

    const modal = el('div', { id: 'dem-modal-bg' });
    modal.innerHTML = `
      <div id="dem-modal">
        <h3>新しいカテゴリ</h3>
        <input id="dem-modal-input" type="text" placeholder="例：推し、リアクション用">
        <div id="dem-modal-btns">
          <button class="dem-modal-btn cancel" id="dem-modal-cancel">キャンセル</button>
          <button class="dem-modal-btn ok" id="dem-modal-ok">作成</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    bindEvents();
    makeDraggable(panel);
  }

  function el(tag, props = {}) {
    const e = document.createElement(tag);
    Object.assign(e, props);
    return e;
  }

  function bindEvents() {
    $('dem-close-btn').onclick   = togglePanel;
    $('dem-modal-cancel').onclick = closeModal;
    $('dem-modal-ok').onclick    = createCategory;
    $('dem-sort-btn').onclick    = cycleSort;
    $('dem-move-btn').onclick    = toggleMoveDropdown;
    $('dem-desel-btn').onclick   = () => { state.selected.clear(); renderGrid(); updateFooter(); };
    $('dem-modal-input').onkeydown = e => { if (e.key === 'Enter') createCategory(); };
    $('dem-search').oninput = e => { state.search = e.target.value.toLowerCase(); renderGrid(); };
    document.addEventListener('click', e => {
      const dd = $('dem-move-dropdown');
      if (dd && !dd.contains(e.target) && e.target !== $('dem-move-btn'))
        dd.classList.remove('dem-visible');
    });
  }

  function $(id) { return document.getElementById(id); }

  // ── パネルドラッグ ────────────────────────────────────────────────────
  function makeDraggable(panel) {
    let on = false, sx, sy, ox, oy;
    $('dem-header').addEventListener('mousedown', e => {
      on = true; sx = e.clientX; sy = e.clientY;
      const r = panel.getBoundingClientRect(); ox = r.left; oy = r.top;
      document.body.style.userSelect = 'none';
    });
    document.addEventListener('mousemove', e => {
      if (!on) return;
      panel.style.cssText += `left:${ox+e.clientX-sx}px;top:${oy+e.clientY-sy}px;right:auto;bottom:auto;`;
    });
    document.addEventListener('mouseup', () => {
      if (!on) return; on = false;
      document.body.style.userSelect = '';
      savePos(parseInt(panel.style.left), parseInt(panel.style.top));
    });
  }

  function applyPos(pos) {
    if (!pos) return;
    const p = $('dem-panel');
    p.style.left = pos.x+'px'; p.style.top = pos.y+'px';
    p.style.right = 'auto'; p.style.bottom = 'auto';
  }

  function togglePanel() {
    state.panelVisible = !state.panelVisible;
    $('dem-panel').classList.toggle('dem-hidden', !state.panelVisible);
    if (state.panelVisible) renderAll();
  }

  // ── レンダリング ──────────────────────────────────────────────────────
  function renderAll() { renderCats(); renderGrid(); updateFooter(); }

  function getCatName(catId) {
    if (!catId) return '未分類';
    const c = state.categories.find(c => c.id === catId);
    return c ? c.name : '未分類';
  }

  function renderCats() {
    const wrap = $('dem-cats');
    wrap.innerHTML = '';

    // フィルター選択肢: すべて / 未分類 / 各カテゴリ
    const tabs = [
      { id: 'all',      label: 'すべて' },
      { id: 'uncat',    label: '未分類' },
      ...state.categories,
    ];

    tabs.forEach(cat => {
      let count;
      if      (cat.id === 'all')   count = state.emojis.length;
      else if (cat.id === 'uncat') count = state.emojis.filter(e => !state.assignments[e.id]).length;
      else                          count = state.emojis.filter(e => state.assignments[e.id] === cat.id).length;

      const btn = el('button', { className: 'dem-cat-tab' + (state.currentCat === cat.id ? ' dem-active' : '') });
      btn.textContent = `${cat.id === 'all' ? 'すべて' : cat.id === 'uncat' ? '未分類' : cat.name} (${count})`;
      btn.addEventListener('click', () => {
        state.currentCat = cat.id; state.selected.clear();
        renderCats(); renderGrid(); updateFooter();
      });

      // カテゴリタブをドロップターゲットに（'all' と 'uncat' 以外）
      if (cat.id !== 'all' && cat.id !== 'uncat') {
        btn.addEventListener('dragover', e => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          btn.classList.add('dem-drop-hover');
        });
        btn.addEventListener('dragleave', () => btn.classList.remove('dem-drop-hover'));
        btn.addEventListener('drop', e => {
          e.preventDefault();
          btn.classList.remove('dem-drop-hover');
          if (!dragIds) return;
          dragIds.forEach(id => { state.assignments[id] = cat.id; });
          saveAssigns();
          state.selected.clear();
          dragIds = null;
          renderAll();
        });
      }
      // 「未分類」タブへのドロップ → 割り当て解除
      if (cat.id === 'uncat') {
        btn.addEventListener('dragover', e => { e.preventDefault(); btn.classList.add('dem-drop-hover'); });
        btn.addEventListener('dragleave', () => btn.classList.remove('dem-drop-hover'));
        btn.addEventListener('drop', e => {
          e.preventDefault();
          btn.classList.remove('dem-drop-hover');
          if (!dragIds) return;
          dragIds.forEach(id => { delete state.assignments[id]; });
          saveAssigns();
          state.selected.clear();
          dragIds = null;
          renderAll();
        });
      }
      wrap.appendChild(btn);
    });

    const addBtn = el('button', { className: 'dem-cat-add-tab' });
    addBtn.textContent = '＋ 追加';
    addBtn.onclick = openModal;
    wrap.appendChild(addBtn);
  }

  function getVisibleEmojis() {
    // emojiOrder に沿って並べ、未登録を末尾に追加
    const ordered = [
      ...state.emojiOrder.map(id => state.emojis.find(e => e.id === id)).filter(Boolean),
      ...state.emojis.filter(e => !state.emojiOrder.includes(e.id)),
    ];
    let list = ordered.filter(e => {
      if (state.search && !e.name.toLowerCase().includes(state.search) && !e.guildName.toLowerCase().includes(state.search)) return false;
      if (state.currentCat === 'all')   return true;
      if (state.currentCat === 'uncat') return !state.assignments[e.id];
      return state.assignments[e.id] === state.currentCat;
    });
    if      (state.sortOrder === 'name')      list.sort((a,b) => a.name.localeCompare(b.name));
    else if (state.sortOrder === 'name_desc') list.sort((a,b) => b.name.localeCompare(a.name));
    else if (state.sortOrder === 'guild')     list.sort((a,b) => (a.guildName||'').localeCompare(b.guildName||''));
    return list;
  }

  function renderInfoBar() {
    const bar = $('dem-info-bar');
    if (state.selected.size === 0) { bar.classList.add('dem-hidden'); return; }

    // 選択中絵文字のカテゴリ集計
    const catCounts = {};
    state.selected.forEach(id => {
      const catId = state.assignments[id] || '__uncat__';
      catCounts[catId] = (catCounts[catId] || 0) + 1;
    });
    const parts = Object.entries(catCounts).map(([catId, n]) =>
      `<span class="dem-info-tag">${getCatName(catId === '__uncat__' ? null : catId)} ×${n}</span>`
    ).join('');
    bar.innerHTML = `<span class="dem-info-label">選択中のカテゴリ：</span>${parts}`;
    bar.classList.remove('dem-hidden');
  }

  function renderGrid() {
    const grid    = $('dem-grid');
    const visible = getVisibleEmojis();
    grid.innerHTML = '';

    if (visible.length === 0) {
      const d = el('div', { className: 'dem-empty' });
      d.textContent = state.emojis.length === 0 ? '絵文字ピッカーを一度開くとカスタム絵文字が読み込まれます' : '絵文字が見つかりません';
      grid.appendChild(d);
      return;
    }

    visible.forEach((emoji, visIdx) => {
      const item = el('div', {
        className: 'dem-emoji-item' + (state.selected.has(emoji.id) ? ' dem-selected' : ''),
        title: `:${emoji.name}:\n${emoji.guildName}`,
        draggable: true,
      });
      item.dataset.id  = emoji.id;
      item.dataset.idx = visIdx;

      if (emoji.unicode) {
        const s = el('span', { className: 'dem-emoji-static' });
        s.textContent = emoji.url;
        item.appendChild(s);
      } else {
        const img = el('img', { className: 'dem-emoji-img', src: emoji.url, alt: emoji.name });
        img.loading   = 'lazy';
        img.draggable = false;           // ブラウザの画像ドラッグを無効化
        img.style.pointerEvents = 'none'; // クリック/ドラッグイベントを親に委譲
        item.appendChild(img);
      }
      const nm = el('div', { className: 'dem-emoji-name' });
      nm.textContent = emoji.name;
      item.appendChild(nm);

      // カテゴリバッジ（選択中のみ表示）
      if (state.selected.has(emoji.id)) {
        const catId   = state.assignments[emoji.id];
        const badge   = el('div', { className: 'dem-emoji-badge' });
        badge.textContent = getCatName(catId || null);
        item.appendChild(badge);
      }

      // ── クリック ──
      let pressTimer;
      item.addEventListener('mousedown', () => {
        pressTimer = setTimeout(() => {
          state.selected.add(emoji.id);
          item.classList.add('dem-selected');
          updateFooter(); renderInfoBar();
        }, 400);
      });
      item.addEventListener('mouseup',    () => clearTimeout(pressTimer));
      item.addEventListener('mouseleave', () => clearTimeout(pressTimer));
      item.addEventListener('click', e => {
        if (e.shiftKey || state.selected.size > 0) {
          if (state.selected.has(emoji.id)) state.selected.delete(emoji.id);
          else state.selected.add(emoji.id);
          item.classList.toggle('dem-selected');
          // バッジ再描画
          const badge = item.querySelector('.dem-emoji-badge');
          if (state.selected.has(emoji.id)) {
            if (!badge) {
              const b = el('div', { className: 'dem-emoji-badge' });
              b.textContent = getCatName(state.assignments[emoji.id] || null);
              item.appendChild(b);
            }
          } else {
            badge && badge.remove();
          }
          updateFooter(); renderInfoBar();
        } else {
          insertEmoji(emoji);
        }
      });

      // ── ドラッグ開始 ──
      item.addEventListener('dragstart', e => {
        clearTimeout(pressTimer);
        dragIds = state.selected.has(emoji.id) && state.selected.size > 0
          ? Array.from(state.selected)
          : [emoji.id];
        // text/plain に JSON を詰めて運ぶ（カスタムMIMEは拡張内では問題ないが念のため）
        e.dataTransfer.setData('text/plain', JSON.stringify(dragIds));
        e.dataTransfer.effectAllowed = 'move';
        setTimeout(() => item.style.opacity = '0.35', 0);
      });
      item.addEventListener('dragend', () => {
        item.style.opacity = '';
        dragIds = null;
        document.querySelectorAll('.dem-drag-over').forEach(el => el.classList.remove('dem-drag-over'));
      });

      // ── グリッド内ドロップ（並び替え） ──
      // dragover: ターゲット絵文字の左半分 → 前に挿入、右半分 → 後に挿入
      item.addEventListener('dragover', e => {
        if (!dragIds) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        document.querySelectorAll('.dem-drag-over, .dem-drag-over-after').forEach(el => {
          el.classList.remove('dem-drag-over', 'dem-drag-over-after');
        });
        if (dragIds.includes(emoji.id)) return;
        const rect   = item.getBoundingClientRect();
        const isLeft = e.clientX < rect.left + rect.width / 2;
        item.classList.add(isLeft ? 'dem-drag-over' : 'dem-drag-over-after');
      });
      item.addEventListener('dragleave', () => {
        item.classList.remove('dem-drag-over', 'dem-drag-over-after');
      });
      item.addEventListener('drop', e => {
        e.preventDefault();
        e.stopPropagation();
        const insertAfter = item.classList.contains('dem-drag-over-after');
        item.classList.remove('dem-drag-over', 'dem-drag-over-after');

        const raw = e.dataTransfer.getData('text/plain');
        if (!raw) return;
        let ids;
        try { ids = JSON.parse(raw); } catch { return; }
        if (ids.includes(emoji.id)) return;

        // emojiOrder からドラッグ対象を除去
        ids.forEach(id => {
          const i = state.emojiOrder.indexOf(id);
          if (i !== -1) state.emojiOrder.splice(i, 1);
        });

        // ターゲットの位置を再取得して挿入
        let at = state.emojiOrder.indexOf(emoji.id);
        if (at === -1) {
          state.emojiOrder.push(...ids);
        } else {
          state.emojiOrder.splice(insertAfter ? at + 1 : at, 0, ...ids);
        }

        saveOrder();
        dragIds = null;
        // カスタム順に切替
        state.sortOrder = 'custom';
        $('dem-sort-btn').textContent = '↕ カスタム順';
        renderGrid();
      });

      grid.appendChild(item);
    });
  }

  function updateFooter() {
    const n   = state.selected.size;
    const inf = $('dem-sel-info'), mv = $('dem-move-btn'), ds = $('dem-desel-btn');
    inf.textContent = n === 0 ? 'クリックで挿入 / ドラッグで並び替え・移動' : `${n}個選択中`;
    mv.classList.toggle('dem-visible', n > 0);
    ds.classList.toggle('dem-visible', n > 0);
    renderInfoBar();
  }

  // ── 絵文字挿入 ────────────────────────────────────────────────────────
  function insertEmoji(emoji) {
    const input = document.querySelector('[data-slate-editor="true"]')
      || document.querySelector('[contenteditable="true"][role="textbox"]')
      || document.querySelector('div[contenteditable="true"]');
    if (!input) return;
    input.focus();
    const text = emoji.unicode ? emoji.url + ' ' : `:${emoji.name}: `;
    const sel  = window.getSelection();
    if (sel && input.childNodes.length > 0) {
      const r = document.createRange();
      r.selectNodeContents(input); r.collapse(false);
      sel.removeAllRanges(); sel.addRange(r);
    }
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    setTimeout(() => {
      if (!input.textContent.includes(text.trim()))
        document.execCommand('insertText', false, text);
    }, 50);
  }

  // ── ソート ────────────────────────────────────────────────────────────
  function cycleSort() {
    const orders = ['custom','name','name_desc','guild'];
    const labels = { custom:'↕ カスタム順', name:'↑ 名前順', name_desc:'↓ 名前逆順', guild:'🏠 サーバー順' };
    state.sortOrder = orders[(orders.indexOf(state.sortOrder)+1) % orders.length];
    $('dem-sort-btn').textContent = labels[state.sortOrder];
    renderGrid();
  }

  // ── 移動ドロップダウン ─────────────────────────────────────────────────
  function toggleMoveDropdown() {
    const dd = $('dem-move-dropdown');
    dd.classList.toggle('dem-visible');
    if (!dd.classList.contains('dem-visible')) return;
    dd.innerHTML = '';
    state.categories.forEach(cat => {
      const opt = el('div', { className: 'dem-move-option' });
      opt.textContent = cat.name;
      opt.onclick = () => {
        state.selected.forEach(id => { state.assignments[id] = cat.id; });
        saveAssigns(); state.selected.clear();
        dd.classList.remove('dem-visible'); renderAll();
      };
      dd.appendChild(opt);
    });
    const uncat = el('div', { className: 'dem-move-option' });
    uncat.textContent = '— 未分類に戻す'; uncat.style.color = '#80848e';
    uncat.onclick = () => {
      state.selected.forEach(id => { delete state.assignments[id]; });
      saveAssigns(); state.selected.clear();
      dd.classList.remove('dem-visible'); renderAll();
    };
    dd.appendChild(uncat);
  }

  // ── カテゴリ作成 ──────────────────────────────────────────────────────
  function openModal()  {
    $('dem-modal-bg').classList.add('dem-visible');
    $('dem-modal-input').value = '';
    setTimeout(() => $('dem-modal-input').focus(), 50);
  }
  function closeModal() { $('dem-modal-bg').classList.remove('dem-visible'); }
  function createCategory() {
    const name = $('dem-modal-input').value.trim();
    if (!name) return;
    state.categories.push({ id: 'cat_'+Date.now(), name });
    saveCats(); closeModal(); renderCats();
  }

  // ── 初期化 ────────────────────────────────────────────────────────────
  async function init() {
    if (document.readyState !== 'complete')
      await new Promise(r => window.addEventListener('load', r));
    const pos = await loadStorage();
    // Unicode絵文字を初期登録
    mergeEmojis(UNICODE_EMOJIS);
    buildPanel();
    if (pos) applyPos(pos);
    watchEmojiPicker();
    console.log('[DEM] 初期化完了');
  }

  let initialized = false;
  new MutationObserver(() => {
    if (!initialized && document.querySelector('[class*="app-"]')) {
      initialized = true; init();
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  if (document.querySelector('[class*="app-"]')) { initialized = true; init(); }

})();
