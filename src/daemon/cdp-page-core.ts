/**
 * Otter Page-Agent Core (ported 1:1 from extension/src/background/browser-controller.ts)
 *
 * Được nạp tự động vào mọi tab Chrome CDP (qua Runtime.evaluate + Page.addScriptToEvaluateOnNewDocument)
 * để chạy đầy đủ sức mạnh của Extension Core trực tiếp trên CDP mà KHÔNG cần cài Chrome Extension:
 * - Alibaba Page-Agent DOM (Shadow DOM, viewport/dialog/Messenger priority, visual numbered badges)
 * - Facebook Feed, Messenger Chat, Notifications, Comments parser
 * - W3C 9-event Pointer/Mouse click + Hit-testing (kết hợp CDP Input.dispatchMouseEvent isTrusted=true)
 * - React 17/18 Native Value Setter + Meta Lexical Editor bypass + ContentEditable typing
 * - Smart Infinite Scroll (Facebook Comet / YouTube / X + auto-retry + bottom bounce)
 * - Facebook React, Comment, Group Post, Media Composer (kết hợp CDP DOM.setFileInputFiles)
 * - Muse AI Web Automation
 * - Visual Activation HUD + Live Hover Inspector
 */

import { OTTER_VERSION } from "./version";

export function isFacebookPostMismatch(curUrl: string, targetPostUrl: string): boolean {
  if (!targetPostUrl || !targetPostUrl.trim()) return false;
  if (!curUrl) return true;
  try {
    const cur = new URL(curUrl.startsWith("http") ? curUrl : `https://${curUrl}`);
    const target = new URL(targetPostUrl.startsWith("http") ? targetPostUrl : `https://${targetPostUrl}`);
    if (!cur.hostname.includes("facebook.com")) return true;
    const nonPostPaths = [
      "/", "", "/home.php", "/watch", "/friends", "/messages",
      "/marketplace", "/notifications", "/bookmarks", "/groups", "/groups/feed", "/groups/feed/",
    ];
    if (nonPostPaths.includes(cur.pathname.toLowerCase())) return true;
    if (cur.pathname.toLowerCase() === "/profile.php" && !cur.searchParams.get("story_fbid") && !cur.searchParams.get("fbid")) {
      return true;
    }
    const targetShare = target.pathname.match(/\/share\/p\/([a-zA-Z0-9_-]+)/i);
    const curShare = cur.pathname.match(/\/share\/p\/([a-zA-Z0-9_-]+)/i);
    if (targetShare && curShare && targetShare[1] !== curShare[1]) return true;

    const targetFbid = target.searchParams.get("story_fbid") || target.searchParams.get("fbid");
    const curFbid = cur.searchParams.get("story_fbid") || cur.searchParams.get("fbid");
    if (targetFbid && curFbid && targetFbid !== curFbid) return true;

    const postPattern = /\/(posts|story\.php|permalink|share\/|videos|photo|groups\/[0-9a-zA-Z._-]+\/(permalink|posts))/i;
    const isCurPost = postPattern.test(cur.pathname) || cur.searchParams.has("story_fbid") || cur.searchParams.has("fbid");
    if (!isCurPost) return true;
    return false;
  } catch {
    return false;
  }
}

export const OTTER_CORE_VERSION = `${OTTER_VERSION}-cdp-core`;

/**
 * Script tự chứa nạp vào window.__otterCore trên mọi tab CDP.
 * Hoàn toàn idempotent: gọi lại nhiều lần không tạo xung đột.
 */
export const OTTER_PAGE_CORE_SCRIPT = `(() => {
  if (window.__otterCore && window.__otterCore.version === ${JSON.stringify(OTTER_CORE_VERSION)}) {
    return { installed: true, reused: true, version: window.__otterCore.version };
  }

  const clean = (s) => (s || '').trim().replace(/\\s+/g, ' ');

  function getIndexedElement(targetIndex) {
    let el = targetIndex > 0 ? document.querySelector('[data-otter-index="' + targetIndex + '"]') : null;
    if (!el && targetIndex > 0) {
      const list = window.__otter_elements || window.__chatmcp_elements || [];
      el = list[targetIndex - 1] || null;
    }
    return el;
  }

  function scrollCenter(el) {
    if (!el) return;
    if (typeof el.scrollIntoViewIfNeeded === 'function') {
      el.scrollIntoViewIfNeeded();
    } else {
      el.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'nearest' });
    }
  }

  function dispatchW3CClick(targetNode) {
    const rect = targetNode.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const doc = targetNode.ownerDocument || document;
    const hit = doc.elementFromPoint(x, y);
    const target = (hit instanceof HTMLElement && targetNode.contains(hit)) ? hit : targetNode;

    const pOpts = { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerType: 'mouse', view: window, buttons: 1 };
    const mOpts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1, view: window };

    target.dispatchEvent(new PointerEvent('pointerover', pOpts));
    target.dispatchEvent(new PointerEvent('pointerenter', { ...pOpts, bubbles: false }));
    target.dispatchEvent(new MouseEvent('mouseover', mOpts));
    target.dispatchEvent(new MouseEvent('mouseenter', { ...mOpts, bubbles: false }));
    target.dispatchEvent(new PointerEvent('pointerdown', pOpts));
    target.dispatchEvent(new MouseEvent('mousedown', mOpts));
    try { targetNode.focus({ preventScroll: true }); } catch {}
    target.dispatchEvent(new PointerEvent('pointerup', { ...pOpts, buttons: 0 }));
    target.dispatchEvent(new MouseEvent('mouseup', { ...mOpts, buttons: 0 }));
    target.click();
    return { x, y };
  }

  function writeLexicalOrEditable(el, text) {
    const lexicalEditor = el.__lexicalEditor || (el.closest('[data-lexical-editor]') && el.closest('[data-lexical-editor]').__lexicalEditor);
    if (lexicalEditor && typeof lexicalEditor.parseEditorState === 'function' && typeof lexicalEditor.setEditorState === 'function') {
      try {
        const newState = {
          root: {
            children: [{
              children: [{
                detail: 0, format: 0, mode: 'normal', style: '',
                text: text, type: 'text', version: 1
              }],
              direction: null, format: '', indent: 0, textFormat: 0, textStyle: '',
              type: 'paragraph', version: 1
            }],
            direction: null, format: '', indent: 0, type: 'root', version: 1
          }
        };
        const parsed = lexicalEditor.parseEditorState(JSON.stringify(newState));
        lexicalEditor.setEditorState(parsed);
        lexicalEditor.focus();
        return;
      } catch {}
    }
    try {
      const doc = el.ownerDocument || document;
      const selection = (doc.defaultView || window).getSelection();
      const range = doc.createRange();
      range.selectNodeContents(el);
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(range);
      }
      doc.execCommand('delete', false);
      doc.execCommand('insertText', false, text);
    } catch {
      el.innerText = text;
    }
  }

  // ── 1. READ PAGE (Full Extension Alibaba Page-Agent DOM Core) ───────────────
  function readPage(options) {
    const showBadges = !options || options.showBadges !== false;
    const INTERACTIVE_SELECTOR = [
      'a', 'button', 'input:not([type="hidden"])', 'select', 'textarea',
      '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
      '[role="switch"]', '[role="tab"]', '[role="menuitem"]', '[role="combobox"]',
      '[role="option"]', '[role="searchbox"]', '[role="textbox"]', '[role="treeitem"]',
      '[contenteditable="true"]', '[contenteditable=""]', '[tabindex]:not([tabindex="-1"])',
      '[onclick]', '[data-action]', 'summary', 'details > summary',
      '[class*="btn"]', '[class*="button"]', '[class*="clickable"]',
      '[class*="card"]', '[class*="service"]', '[id*="btn"]', '[id*="button"]'
    ].join(',');

    function collectCandidates(root, list, depth) {
      if (!root || depth > 10 || list.length >= 1000) return list;
      try {
        const matches = root.querySelectorAll(INTERACTIVE_SELECTOR);
        for (const el of matches) {
          if (list.length >= 1000) break;
          if (el instanceof HTMLElement) list.push(el);
        }
      } catch {}
      try {
        const allNodes = root.querySelectorAll('*');
        for (const node of allNodes) {
          if (list.length >= 1000) break;
          if (node.shadowRoot) collectCandidates(node.shadowRoot, list, depth + 1);
          if (node.tagName === 'IFRAME') {
            try {
              if (node.contentDocument) collectCandidates(node.contentDocument, list, depth + 1);
            } catch {}
          }
        }
      } catch {}
      return list;
    }

    function isElementVisible(el) {
      if (typeof el.checkVisibility === 'function') {
        if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    const rawCandidates = collectCandidates(document, [], 0);
    const vHeight = window.innerHeight;
    const vWidth = window.innerWidth;
    const seenElements = new Set();
    const inViewList = [];
    const outViewList = [];

    for (const el of rawCandidates) {
      if (seenElements.has(el)) continue;
      seenElements.add(el);
      const tag = el.tagName.toLowerCase();
      if (tag === 'input' && el.type === 'hidden') continue;
      if (['script', 'style', 'noscript', 'template', 'meta', 'link'].includes(tag)) continue;
      if (el.id && el.id.startsWith('otter-')) continue;
      if (el.closest && el.closest('#otter-activation-hud, #otter-badges-container')) continue;
      if (tag === 'a' && !el.href && !el.innerText?.trim() && !el.getAttribute('onclick') && !el.getAttribute('role')) continue;
      if (el.parentElement && el.parentElement.closest('button, a, select')) continue;
      if (!isElementVisible(el)) continue;

      const rect = el.getBoundingClientRect();
      const isInView = rect.top < vHeight && rect.bottom > 0 && rect.left < vWidth && rect.right > 0;
      if (isInView) inViewList.push({ el, rect, isInView: true });
      else if (outViewList.length < 35) outViewList.push({ el, rect, isInView: false });
    }

    const chatInputEl = document.querySelector('div[role="textbox"][aria-label*="Viết cho"], div[role="textbox"][aria-label*="Message"]');
    if (chatInputEl && !seenElements.has(chatInputEl)) {
      seenElements.add(chatInputEl);
      inViewList.unshift({ el: chatInputEl, rect: chatInputEl.getBoundingClientRect(), isInView: true });
    }

    const activeDialog = document.querySelector('[role="dialog"]:not([aria-hidden="true"]), [aria-modal="true"]:not([aria-hidden="true"]), [role="region"][aria-label*="Đoạn chat"], [data-pagelet*="ChatTab"]');
    const chatDock = chatInputEl ? (chatInputEl.closest('[role="region"], div[data-pagelet*="ChatTab"]') || chatInputEl.parentElement?.parentElement?.parentElement) : null;

    if (activeDialog || chatDock) {
      inViewList.sort((a, b) => {
        const inChatA = (activeDialog?.contains(a.el) || chatDock?.contains(a.el) || a.el === chatInputEl) ? 0 : 1;
        const inChatB = (activeDialog?.contains(b.el) || chatDock?.contains(b.el) || b.el === chatInputEl) ? 0 : 1;
        if (inChatA !== inChatB) return inChatA - inChatB;
        return a.rect.top - b.rect.top || a.rect.left - b.rect.left;
      });
    } else {
      inViewList.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
    }

    const finalSelection = [...inViewList.slice(0, 50), ...outViewList.slice(0, 15)];
    const interactiveElements = finalSelection.map(item => item.el);
    window.__otter_elements = interactiveElements;
    window.__chatmcp_elements = interactiveElements;

    try {
      document.querySelectorAll('[data-otter-index]').forEach(node => node.removeAttribute('data-otter-index'));
      finalSelection.forEach((item, idx) => {
        try { item.el.setAttribute('data-otter-index', String(idx + 1)); } catch {}
      });
    } catch {}

    // Visual numbered badges
    const CONTAINER_ID = 'otter-badges-container';
    document.getElementById(CONTAINER_ID)?.remove();
    document.getElementById('chatmcp-badges-container')?.remove();

    let badgeContainer = null;
    if (showBadges && document.body) {
      badgeContainer = document.createElement('div');
      badgeContainer.id = CONTAINER_ID;
      badgeContainer.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:2147483646;';
    }
    const pageScrollX = window.scrollX || window.pageXOffset || document.documentElement.scrollLeft || 0;
    const pageScrollY = window.scrollY || window.pageYOffset || document.documentElement.scrollTop || 0;

    const elementsData = finalSelection.map((item, idx) => {
      const index = idx + 1;
      const { el, rect, isInView } = item;
      const tagName = el.tagName.toLowerCase();
      const type = el.type || '';
      const placeholder = el.placeholder || '';
      const ariaLabel = el.getAttribute('aria-label') || el.getAttribute('title') || '';
      const href = el.href || '';
      let text = clean(el.innerText || el.textContent || '');
      if (!text && ariaLabel) text = ariaLabel;
      if (!text && el.alt) text = el.alt;
      if (!text && placeholder) text = placeholder;
      if (text.length > 70) text = text.slice(0, 67) + '...';
      let value = el.value || '';
      if (value.length > 40) value = value.slice(0, 37) + '...';

      if (badgeContainer) {
        const badge = document.createElement('div');
        badge.className = 'otter-alibaba-badge';
        badge.textContent = String(index);
        badge.style.cssText = 'position:absolute;left:' + Math.round(pageScrollX + rect.left) + 'px;top:' + Math.max(0, Math.round(pageScrollY + rect.top - 14)) + 'px;background:#e11d48;color:#fff;font-size:11px;font-family:ui-monospace,monospace;font-weight:700;line-height:1;padding:2px 4px;border-radius:3px;pointer-events:none;box-shadow:0 2px 4px rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.8);';
        badgeContainer.appendChild(badge);
      }

      return {
        index,
        tagName,
        type: type || undefined,
        text: text || undefined,
        value: value || undefined,
        placeholder: placeholder || undefined,
        ariaLabel: ariaLabel || undefined,
        href: href && !href.startsWith('javascript:') ? href : undefined,
        inView: isInView,
        coords: {
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2)
        }
      };
    });

    if (badgeContainer && document.body) {
      document.body.appendChild(badgeContainer);
    }

    // Facebook / Messenger rich extraction (ported 1:1 from Extension BrowserController)
    let fbSummary = '';
    let fbPosts = [];
    let messengerSummary = '';
    let notificationsSummary = '';
    let messengerData = undefined;
    const isFacebook = location.hostname.includes('facebook.com') || location.hostname.includes('messenger.com');

    if (isFacebook) {
      try {
        const indexOfInteractive = (el) => {
          if (!el) return null;
          let idx = interactiveElements.indexOf(el);
          if (idx >= 0) return idx + 1;
          let p = el.parentElement;
          while (p) {
            idx = interactiveElements.indexOf(p);
            if (idx >= 0) return idx + 1;
            p = p.parentElement;
          }
          return null;
        };

        const likeButtons = Array.from(document.querySelectorAll('div[role="button"]')).filter(el => {
          const aria = el.getAttribute('aria-label') || '';
          return aria.startsWith('Bày tỏ cảm xúc Thích về bài viết của') ||
                 aria.startsWith('Bày tỏ cảm xúc về bài viết của') ||
                 aria.startsWith('Gỡ Thích khỏi bài viết của');
        });
        const seenAuthors = new Set();
        for (const likeBtn of likeButtons) {
          const aria = likeBtn.getAttribute('aria-label') || '';
          const author = aria
            .replace(/^Bày tỏ cảm xúc Thích về bài viết của\\s*/, '')
            .replace(/^Bày tỏ cảm xúc về bài viết của\\s*/, '')
            .replace(/^Gỡ Thích khỏi bài viết của\\s*/, '')
            .trim();
          if (!author || seenAuthors.has(author)) continue;
          seenAuthors.add(author);
          const isLiked = aria.startsWith('Gỡ Thích') || (likeBtn.innerText || '').includes('Đã thích');
          let cur = likeBtn.parentElement;
          let bestContainer = null;
          while (cur && cur.tagName !== 'BODY' && cur.getAttribute('role') !== 'main') {
            const hasAuthor = Array.from(cur.querySelectorAll('a, strong, span')).some(s => (s.textContent || '').includes(author));
            if (hasAuthor && cur.contains(likeBtn)) {
              bestContainer = cur;
              if (cur.querySelectorAll('div[role="button"][aria-label*="Bày tỏ cảm xúc"]').length === 1) break;
            }
            cur = cur.parentElement;
          }
          if (!bestContainer) bestContainer = likeBtn.parentElement?.parentElement?.parentElement || null;
          const rawText = bestContainer ? (bestContainer.innerText || '') : '';
          const isSponsored = rawText.includes('Được tài trợ') || rawText.includes('Sponsored');
          const commentBtn = bestContainer ? bestContainer.querySelector('div[role="button"][aria-label*="Bình luận"], div[role="button"][aria-label*="Comment"]') : null;
          const textLines = rawText.split('\\n').map(l => clean(l)).filter(l => l.length >= 2 && l !== 'Facebook' && !l.includes('Chỉ báo trạng thái') && !l.startsWith('Thích:') && !l.startsWith('Yêu thích:'));
          const contentLines = textLines.filter(l => l !== author && l !== 'Bài viết trên Bảng feed' && !l.endsWith('phút trước') && !l.endsWith('giờ trước'));
          fbPosts.push({
            author,
            textSnippet: contentLines.slice(0, 8).join('\\n') || textLines.slice(0, 5).join('\\n'),
            isSponsored,
            isLiked,
            likeIndex: indexOfInteractive(likeBtn),
            commentIndex: indexOfInteractive(commentBtn)
          });
        }

        if (fbPosts.length > 0) {
          fbSummary = '=== DANH SÁCH BÀI VIẾT FACEBOOK FEED TRÊN MÀN HÌNH ===\\n' +
            fbPosts.map((p, i) => {
              const note = p.isSponsored ? ' [QUẢNG CÁO]' : '';
              return '[Bài ' + (i + 1) + '] Tác giả: ' + p.author + note + '\\n' +
                '- Trạng thái: ' + (p.isLiked ? 'ĐÃ THÍCH' : 'CHƯA THÍCH') + '\\n' +
                '- Thao tác: Bấm Thích -> browser_click({ index: ' + (p.likeIndex || 'n/a') + ' })' + (p.commentIndex ? ' | Bấm Bình luận -> browser_click({ index: ' + p.commentIndex + ' })' : '') + '\\n' +
                '- Nội dung bài viết:\\n' + p.textSnippet + '\\n';
            }).join('\\n----------------------------------------\\n') + '\\n\\n';
        }

        // Messenger chat box
        const chatBoxEl = document.querySelector(
          'div[role="textbox"][aria-label*="Viết cho" i], div[role="textbox"][aria-label*="Message" i], div[role="textbox"][aria-label*="Tin nhắn" i], div[role="textbox"][aria-label*="Nhập tin nhắn" i], div[role="textbox"][aria-label*="Nhắn tin" i], div[role="textbox"][contenteditable="true"]'
        );
        const msgLogEl = document.querySelector('[role="log"][aria-label*="Tin nhắn trong cuộc trò chuyện" i], [role="log"][aria-label*="Messages" i], [role="log"], [role="grid"][aria-label*="Tin nhắn" i]');
        if (chatBoxEl || msgLogEl) {
          let recipient = (chatBoxEl?.getAttribute('aria-label') || '').replace(/^Viết cho\\s*/i, '').replace(/^Nhắn tin cho\\s*/i, '').trim() ||
                          (msgLogEl?.getAttribute('aria-label') || '').replace(/^Tin nhắn trong cuộc trò chuyện với\\s*/i, '').replace(/^Messages in conversation with\\s*/i, '').trim();
          if (!recipient || recipient.toLowerCase() === 'tin nhắn' || recipient.toLowerCase() === 'message') {
            const headerEl = document.querySelector('[data-testid="chat-header"] strong, div[role="dialog"] h2, div[aria-label*="Đoạn chat với" i] [role="heading"], div[role="main"] h1, div[role="main"] h2');
            recipient = (headerEl?.textContent || '').trim() || 'Người dùng';
          }
          const parseMsgAria = (raw) => {
            if (!raw || raw.length < 3) return null;
            let m = raw.match(/^(?:Nhập,\\s*)?(?:Tin nhắn do|Tin nhắn của)\\s+(.+?)\\s+gửi lúc\\s+.*?\\d{1,2}:\\d{2}\\s*(?:sáng|ch|trưa|tối|am|pm)?:\\s*([\\s\\S]*)/i);
            if (m) return { sender: m[1].trim(), text: m[2].trim() };
            m = raw.match(/^(?:Enter,\\s*)?Message (?:from|sent by)\\s+(.+?)\\s+(?:at|sent at)\\s+.*?\\d{1,2}:\\d{2}\\s*(?:am|pm)?:\\s*([\\s\\S]*)/i);
            if (m) return { sender: m[1].trim(), text: m[2].trim() };
            m = raw.match(/^Lúc\\s+.*?\\d{1,2}:\\d{2}(?:[,\\s]+([^:]+))?:\\s*([\\s\\S]*)/i);
            if (m) return { sender: (m[1] || 'Khách').trim(), text: m[2].trim() };
            return null;
          };
          const parsedTurns = [];
          const seenTurns = new Set();
          for (const el of document.querySelectorAll('[aria-label*="Tin nhắn" i], [aria-label*="lúc " i], [aria-label*="Message" i]')) {
            const parsed = parseMsgAria(el.getAttribute('aria-label') || '');
            if (parsed && parsed.text) {
              const key = parsed.sender + ':' + parsed.text.slice(0, 80);
              if (!seenTurns.has(key)) {
                seenTurns.add(key);
                parsedTurns.push(parsed);
              }
            }
          }
          const recentTurns = parsedTurns.slice(-10);
          const formattedTurns = recentTurns.map(t => t.sender + ': ' + (t.text.length > 250 ? t.text.slice(0, 250) + '...' : t.text)).join('\\n  ');
          const inputIdx = chatBoxEl ? (interactiveElements.indexOf(chatBoxEl) + 1 || null) : null;
          messengerSummary = '=== KHUNG CHAT TIN NHẮN MESSENGER ĐANG MỞ ===\\n' +
            '- Đang nhắn tin với: ' + recipient + '\\n' +
            '- Ô nhập tin nhắn trả lời: browser_type({ index: ' + (inputIdx || 'n/a') + ', text: "..." })\\n' +
            '- Tin nhắn trong cuộc trò chuyện:\\n  ' + (formattedTurns || '(Chưa có tin nhắn cũ)') + '\\n\\n';
          messengerData = { isOpen: true, recipient, inputIndex: inputIdx, messages: recentTurns };
        }

        // Unread messenger dropdown rows
        const messengerRows = Array.from(document.querySelectorAll('a[role="link"][href*="/messages/t/"], div[aria-label*="Đoạn chat"] [role="listitem"], div[aria-label*="Messenger"] [role="listitem"]'))
          .filter(el => (el.innerText || '').includes('Tin nhắn chưa đọc') || (el.innerText || '').includes('phút') || (el.innerText || '').includes('giờ'));
        if (messengerRows.length > 0) {
          const unreadChats = messengerRows.slice(0, 5).map((row, i) => {
            const lines = (row.innerText || '').split('\\n').map(l => l.trim()).filter(Boolean);
            const name = lines[0] || 'Khách hàng';
            const msg = lines.find(l => !l.includes('Tin nhắn chưa đọc') && l !== name && !l.endsWith('phút') && !l.endsWith('giờ') && !l.startsWith('·')) || lines[1] || '';
            const clickIdx = interactiveElements.indexOf(row) + 1 || (row.querySelector('a') ? interactiveElements.indexOf(row.querySelector('a')) + 1 : null);
            return '[' + (i + 1) + '] Khách: ' + name + ' | Tin gần nhất: "' + msg + '" | Thao tác mở: browser_click({ index: ' + (clickIdx || 'n/a') + ' })';
          });
          messengerSummary += '=== DANH SÁCH TIN NHẮN MESSENGER (CHỌN ĐỂ MỞ & TRẢ LỜI) ===\\n' + unreadChats.join('\\n') + '\\n\\n';
        }

        // Notifications dropdown
        const notifRows = Array.from(document.querySelectorAll('div[role="dialog"] a[role="link"][href*="notif_id"], div[aria-label*="Thông báo"] a[role="link"], div[aria-label*="Thông báo"] [role="listitem"]'))
          .filter(el => (el.innerText || '').length > 10);
        if (notifRows.length > 0) {
          const parsedNotifs = notifRows.slice(0, 6).map((row, i) => {
            const lines = (row.innerText || '').split('\\n').map(l => l.trim()).filter(Boolean);
            const isUnread = lines.includes('Chưa đọc');
            const contentLines = lines.filter(l => l !== 'Chưa đọc' && !l.includes('phút') && !l.includes('giờ') && !l.includes('ngày') && !l.startsWith('·'));
            const timeLine = lines.find(l => l.includes('phút') || l.includes('giờ') || l.includes('ngày') || l.includes('Hôm qua')) || '';
            const clickIdx = interactiveElements.indexOf(row) + 1 || (row.querySelector('a') ? interactiveElements.indexOf(row.querySelector('a')) + 1 : null);
            return '[' + (i + 1) + '] [' + (isUnread ? 'CHƯA ĐỌC' : 'ĐÃ XEM') + '] ' + contentLines.join(' - ') + ' (' + timeLine + ') | Thao tác mở bài viết: browser_click({ index: ' + (clickIdx || 'n/a') + ' })';
          });
          notificationsSummary = '=== DANH SÁCH THÔNG BÁO FACEBOOK (NOTIFICATIONS) ===\\n' + parsedNotifs.join('\\n') + '\\n\\n';
        }
      } catch {}
    }

    const contentNodes = Array.from(document.querySelectorAll('h1, h2, h3, p, [role="heading"], article, #video-title, .title'));
    let textSummary = '';
    const seenSummary = new Set();
    for (const n of contentNodes) {
      if (n.closest && n.closest('#otter-activation-hud, #otter-badges-container')) continue;
      const t = clean(n.textContent || '');
      if (t.length > 10 && !t.includes('{') && !t.includes('}') && !seenSummary.has(t)) {
        seenSummary.add(t);
        textSummary += t + '\\n';
        if (textSummary.length > 2500) break;
      }
    }

    return {
      title: document.title,
      url: location.href,
      elementsCount: elementsData.length,
      elements: elementsData,
      feedPosts: isFacebook ? fbPosts : undefined,
      messenger: isFacebook ? messengerData : undefined,
      summaryText: (messengerSummary + notificationsSummary + fbSummary + textSummary).slice(0, 5000)
    };
  }

  // ── 2. CLICK PREP + W3C CLICK ───────────────────────────────────────────────
  function prepClick(targetIndex) {
    const el = getIndexedElement(targetIndex);
    if (!el) return { ok: false, error: 'Không tìm thấy phần tử có chỉ số [' + targetIndex + ']' };
    scrollCenter(el);
    const rect = el.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    const inViewport = x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight && rect.width > 0 && rect.height > 0;
    return {
      ok: true,
      x, y, inViewport,
      tag: el.tagName.toLowerCase(),
      text: clean(el.innerText || el.value || el.getAttribute('aria-label') || el.tagName).slice(0, 40)
    };
  }

  function w3cClick(targetIndex) {
    const el = getIndexedElement(targetIndex);
    if (!el) return { ok: false, message: 'Không tìm thấy phần tử có chỉ số [' + targetIndex + ']' };
    scrollCenter(el);
    dispatchW3CClick(el);
    return {
      ok: true,
      message: 'Đã kích hoạt click W3C thành công trên [' + targetIndex + '] <' + el.tagName.toLowerCase() + '> "' + clean(el.innerText || el.textContent || '').slice(0, 40) + '"'
    };
  }

  // ── 3. TYPE (React Native Setter + Meta Lexical + ContentEditable) ──────────
  function typeElement(targetIndex, textToType, shouldEnter) {
    let el = getIndexedElement(targetIndex);
    if (!el) {
      const active = document.activeElement;
      if (active && (active.isContentEditable || active.getAttribute('role') === 'textbox' || active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) {
        el = active;
      }
    }
    if (!el) {
      const activeBoxes = Array.from(document.querySelectorAll('[role="textbox"][contenteditable="true"], div[contenteditable="true"]'));
      if (activeBoxes.length > 0) el = activeBoxes[activeBoxes.length - 1];
    }
    if (!el) return { ok: false, message: 'Không tìm thấy phần tử có chỉ số [' + targetIndex + ']' };

    scrollCenter(el);
    el.focus();

    const isContentEditable = el.isContentEditable || el.getAttribute('contenteditable') === 'true';
    const tag = el.tagName.toLowerCase();
    const isInput = tag === 'input';
    const isTextArea = tag === 'textarea';

    if (isInput || isTextArea) {
      const proto = isInput ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'deleteContent' }));
      if (nativeSetter) nativeSetter.call(el, ''); else el.value = '';
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContent' }));
      el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: textToType }));
      if (nativeSetter) nativeSetter.call(el, textToType); else el.value = textToType;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: textToType }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (isContentEditable) {
      writeLexicalOrEditable(el, textToType);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      el.innerText = textToType;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }

    const ariaLabelLower = (el.getAttribute('aria-label') || '').toLowerCase();
    const isCommentBox = ariaLabelLower.includes('bình luận') ||
                         ariaLabelLower.includes('trả lời') ||
                         ariaLabelLower.includes('comment') ||
                         ariaLabelLower.includes('reply') ||
                         (el.getAttribute('role') === 'textbox' && isContentEditable);
    const needEnter = Boolean(shouldEnter || isCommentBox);

    if (needEnter) {
      const enterOpts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
      el.dispatchEvent(new KeyboardEvent('keydown', enterOpts));
      el.dispatchEvent(new KeyboardEvent('keypress', enterOpts));
      el.dispatchEvent(new KeyboardEvent('keyup', enterOpts));
      if (el.form) el.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

      setTimeout(() => {
        let container = el.parentElement;
        let sendBtn = null;
        for (let i = 0; i < 8; i++) {
          if (!container) break;
          sendBtn = container.querySelector('div[role="button"][aria-label*="Đăng bình luận"], div[role="button"][aria-label*="Comment"], div[role="button"][aria-label*="Nhấn Enter để gửi"], div[role="button"][aria-label*="Press Enter to send"]');
          if (sendBtn) break;
          container = container.parentElement;
        }
        if (!sendBtn) {
          sendBtn = document.querySelector('div[role="button"][aria-label*="Đăng bình luận"], div[role="button"][aria-label*="Comment"]');
        }
        if (sendBtn) sendBtn.click();
      }, 350);
    }

    return {
      ok: true,
      needHardwareEnter: needEnter,
      tag,
      message: 'Đã nhập "' + textToType + '" vào [' + targetIndex + '] <' + tag + '> thành công' + (shouldEnter ? ' (kèm nhấn Enter)' : '')
    };
  }

  // ── 4. SELECT OPTION ────────────────────────────────────────────────────────
  function selectOption(targetIndex, optionChoice) {
    const el = getIndexedElement(targetIndex);
    if (!el || el.tagName.toLowerCase() !== 'select') {
      return { ok: false, message: 'Phần tử [' + targetIndex + '] không phải là thẻ dropdown <select>' };
    }
    const options = Array.from(el.options);
    const choiceLower = String(optionChoice || '').trim().toLowerCase();
    const matched = options.find(opt =>
      opt.text.trim().toLowerCase() === choiceLower ||
      opt.value.trim().toLowerCase() === choiceLower ||
      opt.text.trim().toLowerCase().includes(choiceLower)
    );
    if (!matched) {
      return { ok: false, message: 'Không tìm thấy option "' + optionChoice + '". Có sẵn: ' + options.map(o => '"' + o.text.trim() + '"').join(', ') };
    }
    scrollCenter(el);
    el.focus();
    el.value = matched.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return {
      ok: true,
      message: 'Đã chọn option "' + matched.text.trim() + '" (value: "' + matched.value + '") trên dropdown [' + targetIndex + ']'
    };
  }

  // ── 5. SMART INFINITE SCROLL ────────────────────────────────────────────────
  function scrollPage(dir, px) {
    return new Promise((resolve) => {
      const delta = dir === 'down' ? px : -px;
      window.scrollBy({ top: delta, behavior: 'smooth' });
      const scroller = document.scrollingElement || document.documentElement || document.body;
      if (scroller) scroller.scrollTop += delta;
      try {
        window.dispatchEvent(new Event('scroll', { bubbles: true }));
        window.dispatchEvent(new WheelEvent('wheel', { deltaY: delta, bubbles: true }));
        document.dispatchEvent(new Event('scroll', { bubbles: true }));
      } catch {}
      try {
        const articles = Array.from(document.querySelectorAll('[role="article"], div[role="feed"] > div'));
        if (articles.length > 0 && dir === 'down') {
          articles[articles.length - 1].scrollIntoView({ behavior: 'smooth', block: 'end' });
        }
      } catch {}
      try {
        const retryButtons = Array.from(document.querySelectorAll('[role="button"], span, div')).filter(el => {
          const txt = (el.innerText || '').trim();
          return (txt === 'Thử lại' || txt === 'Tải lại' || txt.includes('thử tải lại')) && el.offsetParent !== null;
        });
        if (retryButtons.length > 0) retryButtons[0].click();
      } catch {}

      setTimeout(() => {
        const currentY = Math.round(window.scrollY || window.pageYOffset || document.documentElement.scrollTop || 0);
        const currentH = document.documentElement.scrollHeight;
        const clientH = window.innerHeight || document.documentElement.clientHeight || 0;
        const reachedBottom = dir === 'down' && (currentY + clientH >= currentH - 50);
        if (reachedBottom) {
          window.scrollBy({ top: -120, behavior: 'instant' });
          setTimeout(() => {
            window.scrollBy({ top: 150, behavior: 'instant' });
            window.dispatchEvent(new Event('scroll', { bubbles: true }));
            window.dispatchEvent(new WheelEvent('wheel', { deltaY: 300, bubbles: true }));
          }, 100);
        }
        resolve({
          ok: true,
          message: 'Đã cuộn trang ' + (dir === 'down' ? 'xuống' : 'lên') + ' ' + px + 'px (vị trí: ' + currentY + 'px, chiều cao: ' + currentH + 'px' + (reachedBottom ? ' - Đã chạm đáy' : '') + ')',
          scrollY: currentY,
          scrollHeight: currentH,
          reachedBottom
        });
      }, 600);
    });
  }

  // ── 6. CLOSE MESSENGER DOCKS ────────────────────────────────────────────────
  function closeMessengerDocks() {
    const sel = 'div[role="button"][aria-label*="Đóng đoạn chat"], div[role="button"][aria-label*="Đóng cuộc trò chuyện"], div[role="button"][aria-label*="Close chat"], div[role="button"][aria-label*="Close conversation"]';
    const buttons = Array.from(document.querySelectorAll(sel));
    let closedCount = 0;
    for (const btn of buttons) {
      try { btn.click(); closedCount++; } catch {}
    }
    return {
      ok: true,
      closedCount,
      message: closedCount > 0 ? ('Đã đóng ' + closedCount + ' khung chat Messenger đang mở.') : 'Không có khung chat Messenger nào đang mở.'
    };
  }

  // ── 7. READ FACEBOOK COMMENTS ───────────────────────────────────────────────
  function readComments(currentUser) {
    const INTERACTIVE_SELECTOR = 'a, button, input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [contenteditable="true"], [contenteditable=""], [tabindex]:not([tabindex="-1"]), [onclick]';
    const interactive = [];
    const seen = new Set();
    try {
      for (const el of document.querySelectorAll(INTERACTIVE_SELECTOR)) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (el.parentElement && el.parentElement.closest('button, a, select')) continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        interactive.push(el);
      }
    } catch {}
    window.__otter_elements = interactive;
    window.__chatmcp_elements = interactive;
    try {
      document.querySelectorAll('[data-otter-index]').forEach(n => n.removeAttribute('data-otter-index'));
      interactive.forEach((el, idx) => { try { el.setAttribute('data-otter-index', String(idx + 1)); } catch {} });
    } catch {}

    const indexOf = (el) => {
      if (!el) return null;
      const idx = interactive.indexOf(el);
      if (idx >= 0) return idx + 1;
      interactive.push(el);
      const newIdx = interactive.length;
      try { el.setAttribute('data-otter-index', String(newIdx)); } catch {}
      return newIdx;
    };

    function parseName(name) {
      const t = clean(name);
      if (!t) return null;
      const vnReply = 'Phản hồi bình luận của ';
      if (t.startsWith(vnReply)) {
        const rest = t.slice(vnReply.length);
        const byIdx = rest.lastIndexOf(' dưới tên ');
        if (byIdx < 0) return null;
        const parentAuthor = rest.slice(0, byIdx).trim();
        const tail = rest.slice(byIdx + ' dưới tên '.length);
        const intoIdx = tail.lastIndexOf(' vào ');
        if (intoIdx < 0 || !parentAuthor) return null;
        return { parentAuthor, author: tail.slice(0, intoIdx).trim(), time: tail.slice(intoIdx + 5).trim(), strategy: 'vn-reply' };
      }
      const vnTop = 'Bình luận dưới tên ';
      if (t.startsWith(vnTop)) {
        const tail = t.slice(vnTop.length);
        const intoIdx = tail.lastIndexOf(' vào ');
        if (intoIdx < 0) return null;
        return { parentAuthor: null, author: tail.slice(0, intoIdx).trim(), time: tail.slice(intoIdx + 5).trim(), strategy: 'vn-top' };
      }
      const enTop = 'Comment by ';
      if (t.startsWith(enTop)) {
        const rest = t.slice(enTop.length);
        const dotIdx = rest.lastIndexOf(' · ');
        return dotIdx >= 0
          ? { parentAuthor: null, author: rest.slice(0, dotIdx).trim(), time: rest.slice(dotIdx + 3).trim(), strategy: 'en-top' }
          : { parentAuthor: null, author: rest.trim(), time: '', strategy: 'en-top' };
      }
      const enReply = 'Reply to ';
      if (t.startsWith(enReply)) {
        const byIdx = t.lastIndexOf("'s comment by ");
        if (byIdx < 0) return null;
        const parentAuthor = t.slice(enReply.length, byIdx).trim();
        const author = t.slice(byIdx + "'s comment by ".length).trim();
        if (!parentAuthor || !author) return null;
        return { parentAuthor, author, time: '', strategy: 'en-reply' };
      }
      return null;
    }

    const allArticles = Array.from(document.querySelectorAll('article, [role="article"]'));
    let articles = allArticles;
    let scopedToDialog = false;
    try {
      for (const dialog of document.querySelectorAll('[role="dialog"]')) {
        const inDialog = Array.from(dialog.querySelectorAll('article, [role="article"]'));
        if (inDialog.some(a => parseName(a.getAttribute('aria-label') || '') !== null)) {
          articles = inDialog;
          scopedToDialog = true;
          break;
        }
      }
    } catch {}

    const comments = [];
    const unmatchedSamples = [];
    let lastTopKey = '';
    let matchedByAriaLabel = false;

    for (const article of articles) {
      const ariaLabel = article.getAttribute('aria-label') || '';
      const parsed = ariaLabel ? parseName(ariaLabel) : null;
      if (!parsed) {
        if (ariaLabel && unmatchedSamples.length < 3) unmatchedSamples.push(ariaLabel.slice(0, 80));
        continue;
      }
      matchedByAriaLabel = true;
      let text = clean(article.innerText || article.textContent || '');
      if (parsed.author) text = text.replace(parsed.author, '').trim();
      if (parsed.time) {
        const ti = text.lastIndexOf(parsed.time);
        if (ti >= 0) text = text.slice(0, ti).trim();
      }
      text = text.replace(/Xem thông tin về huy hiệu danh tính/g, '').replace(/^Tác giả\\s*/g, '').trim();
      if (parsed.parentAuthor && text.startsWith(parsed.parentAuthor)) text = text.slice(parsed.parentAuthor.length).trim();
      const truncated = text.length > 1000;
      if (truncated) text = text.slice(0, 1000);

      let replyIndex = null;
      let likeIndex = null;
      let isLiked = false;
      try {
        const allEls = Array.from(article.querySelectorAll('button, [role="button"], a, div, span'));
        for (const el of allEls) {
          const aria = clean(el.getAttribute('aria-label') || '');
          const txt = clean(el.innerText || el.textContent || '');
          const isBtn = el.getAttribute('role') === 'button' || el.tagName === 'BUTTON';
          if (/^(Gỡ Thích|Gỡ Yêu thích|Remove Like|Unlike)/i.test(aria) || /^(Gỡ Thích|Gỡ Yêu thích|Remove Like|Unlike)/i.test(txt) || el.getAttribute('aria-pressed') === 'true') isLiked = true;
          if (likeIndex === null && isBtn && /^(Thích|Like)$/i.test(aria)) likeIndex = indexOf(el);
          if (replyIndex === null && isBtn && (/^(Trả lời|Reply)$/i.test(txt) || /^(Trả lời|Reply)$/i.test(aria))) replyIndex = indexOf(el);
        }
        if (likeIndex === null) {
          for (const el of allEls) {
            if (el.children.length > 0 && el.querySelector('[role="button"], button')) continue;
            const aria = clean(el.getAttribute('aria-label') || '');
            const txt = clean(el.innerText || el.textContent || '');
            if (/^(Thích|Like)$/i.test(aria) || /^(Thích|Like)$/i.test(txt)) { likeIndex = indexOf(el); break; }
          }
        }
        if (replyIndex === null) {
          for (const el of allEls) {
            if (el.children.length > 0 && el.querySelector('[role="button"], button')) continue;
            const aria = clean(el.getAttribute('aria-label') || '');
            const txt = clean(el.innerText || el.textContent || '');
            if (/^(Trả lời|Reply)$/i.test(txt) || /^(Trả lời|Reply)$/i.test(aria)) { replyIndex = indexOf(el); break; }
          }
        }
      } catch {}

      const isReply = parsed.parentAuthor !== null;
      const key = parsed.author + '\\n' + text + '\\n' + parsed.time;
      if (!isReply) lastTopKey = key;
      comments.push({
        author: parsed.author, parentAuthor: parsed.parentAuthor, isReply,
        parentKey: isReply ? lastTopKey : null, text, truncated, time: parsed.time,
        strategy: parsed.strategy, replyIndex, likeIndex, isLiked
      });
      if (comments.length >= 50) break;
    }

    const loadMore = [];
    const replyExpansion = [];
    try {
      for (const b of document.querySelectorAll('button, [role="button"]')) {
        const label = clean(b.innerText || b.getAttribute('aria-label') || '');
        if (/Xem thêm bình luận|Xem thêm phản hồi|Xem thêm câu trả lời|Tải thêm bình luận/i.test(label)) {
          if (!loadMore.includes(label)) loadMore.push(label);
        } else if (/Xem \\d+ phản hồi|Xem tất cả \\d+ phản hồi|Xem \\d+ câu trả lời/i.test(label)) {
          if (!replyExpansion.includes(label)) replyExpansion.push(label);
        }
      }
    } catch {}

    const bodyText = clean(document.body?.innerText || '');
    const loginWall = bodyText.includes('Hãy đăng nhập hoặc đăng ký Facebook') || !!document.querySelector('input[type="password"]');
    const hasOwnReplyByKey = new Map();
    if (currentUser) {
      for (const c of comments) {
        if (c.isReply && c.parentKey && c.author === currentUser) hasOwnReplyByKey.set(c.parentKey, true);
      }
    }

    return {
      postUrl: location.href,
      loginWall,
      replyControlsObserved: comments.some(c => c.replyIndex !== null),
      matchedByAriaLabel,
      scopedToDialog,
      articlesFound: articles.length,
      totalArticlesInPage: allArticles.length,
      unmatchedSamples,
      loadMoreButtons: loadMore,
      replyExpansionButtons: replyExpansion,
      hasMore: loadMore.length > 0,
      totalSeen: comments.length,
      comments: comments.map(c => ({
        ...c,
        hasOwnReply: c.isReply ? null : (currentUser ? (hasOwnReplyByKey.get(c.author + '\\n' + c.text + '\\n' + c.time) ?? false) : null)
      }))
    };
  }

  // ── 8. READ FACEBOOK FEED ───────────────────────────────────────────────────
  function readFeed() {
    closeMessengerDocks();
    const INTERACTIVE_SELECTOR = 'a, button, input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [contenteditable="true"], [contenteditable=""]';
    const interactive = [];
    const seen = new Set();
    try {
      for (const el of document.querySelectorAll(INTERACTIVE_SELECTOR)) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (el.parentElement && el.parentElement.closest('button, a, select')) continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        interactive.push(el);
      }
    } catch {}
    window.__otter_elements = interactive;
    window.__chatmcp_elements = interactive;
    try {
      document.querySelectorAll('[data-otter-index]').forEach(n => n.removeAttribute('data-otter-index'));
      interactive.forEach((el, idx) => { try { el.setAttribute('data-otter-index', String(idx + 1)); } catch {} });
    } catch {}
    const indexOf = (el) => {
      if (!el) return null;
      let idx = interactive.indexOf(el);
      if (idx >= 0) return idx + 1;
      let p = el.parentElement;
      while (p) { idx = interactive.indexOf(p); if (idx >= 0) return idx + 1; p = p.parentElement; }
      return null;
    };
    const likeButtons = Array.from(document.querySelectorAll('div[role="button"]')).filter(el => {
      const aria = el.getAttribute('aria-label') || '';
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      return aria.startsWith('Bày tỏ cảm xúc Thích về bài viết của') || aria.startsWith('Bày tỏ cảm xúc về bài viết của') ||
             aria.startsWith('Gỡ Thích khỏi bài viết của') || aria.startsWith('Gỡ Yêu thích khỏi bài viết của') || aria.includes('Thích về bài viết');
    });
    const posts = [];
    const seenAuthors = new Set();
    for (const likeBtn of likeButtons) {
      const aria = likeBtn.getAttribute('aria-label') || '';
      const author = aria
        .replace(/^Bày tỏ cảm xúc Thích về bài viết của\\s*/, '')
        .replace(/^Bày tỏ cảm xúc về bài viết của\\s*/, '')
        .replace(/^Gỡ Thích khỏi bài viết của\\s*/, '')
        .replace(/^Gỡ Yêu thích khỏi bài viết của\\s*/, '')
        .replace(/^Gỡ [^k]+ khỏi bài viết của\\s*/, '')
        .trim();
      if (!author || seenAuthors.has(author)) continue;
      seenAuthors.add(author);
      const isLiked = aria.startsWith('Gỡ ') || (likeBtn.innerText || '').includes('Đã thích');
      let cur = likeBtn.parentElement;
      let bestContainer = null;
      while (cur && cur.tagName !== 'BODY' && cur.getAttribute('role') !== 'main') {
        const hasAuthor = Array.from(cur.querySelectorAll('a, strong, span')).some(s => (s.innerText || '').includes(author));
        if (hasAuthor && cur.contains(likeBtn)) {
          bestContainer = cur;
          if (cur.querySelectorAll('div[role="button"][aria-label*="Bày tỏ cảm xúc"], div[role="button"][aria-label*="Gỡ"]').length >= 1) break;
        }
        cur = cur.parentElement;
      }
      if (!bestContainer) bestContainer = likeBtn.parentElement?.parentElement?.parentElement || null;
      const rawText = bestContainer ? (bestContainer.innerText || '') : '';
      const isSponsored = rawText.includes('Được tài trợ') || rawText.includes('Sponsored') || /s[\\s\\S]{0,5}p[\\s\\S]{0,5}o[\\s\\S]{0,5}n[\\s\\S]{0,5}s[\\s\\S]{0,5}o[\\s\\S]{0,5}r/i.test(rawText);
      const commentBtn = bestContainer ? bestContainer.querySelector('div[role="button"][aria-label*="Bình luận"], div[role="button"][aria-label*="Comment"]') : null;
      const textLines = rawText.split('\\n').map(l => clean(l)).filter(l => l.length > 0 && l !== 'Facebook' && !l.startsWith('Thích:') && !l.startsWith('Yêu thích:'));
      posts.push({ author, textSnippet: textLines.slice(0, 8).join('\\n'), isSponsored, isLiked, likeIndex: indexOf(likeBtn), commentIndex: indexOf(commentBtn) });
    }
    return { totalPosts: posts.length, posts };
  }

  // ── 9. FACEBOOK REACT / COMMENT / GROUP POST ────────────────────────────────
  async function reactFacebook(targetIndex, postAuthor, targetReaction) {
    let el = typeof targetIndex === 'number' && targetIndex > 0 ? getIndexedElement(targetIndex) : null;
    if (!el || (!el.getAttribute('aria-label')?.includes('Thích') && !el.getAttribute('aria-label')?.includes('cảm xúc') && !el.getAttribute('aria-label')?.includes('Gỡ'))) {
      el = Array.from(document.querySelectorAll('div[role="button"]')).find(b => {
        const aria = b.getAttribute('aria-label') || '';
        const r = b.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const okAuthor = postAuthor ? aria.includes(postAuthor) : true;
        return okAuthor && (aria.startsWith('Bày tỏ cảm xúc Thích về bài viết') || aria.startsWith('Gỡ ') || aria.includes('Thích về bài viết'));
      }) || null;
    }
    if (!el) return { ok: false, message: 'Không tìm thấy nút Thích của bài viết' + (postAuthor ? ' (' + postAuthor + ')' : '') };
    scrollCenter(el);
    const currentAria = el.getAttribute('aria-label') || '';
    const isAlreadyLiked = currentAria.startsWith('Gỡ');
    if (targetReaction === 'none') return { ok: true, message: 'Bỏ qua cảm xúc theo yêu cầu', actualReaction: 'none' };
    if (!targetReaction || targetReaction === 'like') {
      if (isAlreadyLiked) return { ok: true, message: 'Bài viết đã được thích trước đó', actualReaction: 'liked' };
      dispatchW3CClick(el);
      return { ok: true, message: 'Đã Thích bài viết thành công!', actualReaction: 'liked' };
    }
    const triggerBtn = el.parentElement?.querySelector('div[role="button"][aria-label*="Bày tỏ cảm xúc về bài viết"], div[role="button"][aria-label*="Thay đổi cảm xúc"]') || el;
    dispatchW3CClick(triggerBtn);
    await new Promise(r => setTimeout(r, 600));
    const kwMap = { love: ['yêu thích', 'love'], care: ['thương thương', 'care'], haha: ['haha'], wow: ['wow'], sad: ['buồn', 'sad'], angry: ['phẫn nộ', 'angry'] };
    const kws = kwMap[targetReaction] || ['yêu thích', 'love'];
    const rBtn = Array.from(document.querySelectorAll('[role="toolbar"] [role="button"], div[role="button"]')).find(b => {
      const a = (b.getAttribute('aria-label') || '').toLowerCase();
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && kws.some(kw => a === kw);
    });
    if (rBtn) {
      dispatchW3CClick(rBtn.querySelector('canvas') || rBtn);
      return { ok: true, message: 'Đã thả biểu tượng cảm xúc "' + targetReaction + '" thành công!', actualReaction: targetReaction };
    }
    if (!isAlreadyLiked) dispatchW3CClick(el);
    return { ok: true, message: 'Không thấy toolbar reaction, đã fallback Like thường.', actualReaction: 'liked' };
  }

  async function commentFacebook(targetIndex, postAuthor, textToType) {
    let tb = document.querySelector('[role="textbox"][contenteditable="true"]');
    if (!tb) {
      let commentBtn = typeof targetIndex === 'number' && targetIndex > 0 ? getIndexedElement(targetIndex) : null;
      if (!commentBtn && postAuthor) {
        const allBtns = Array.from(document.querySelectorAll('div[role="button"]'));
        commentBtn = allBtns.find(b => {
          const a = b.getAttribute('aria-label') || '';
          const r = b.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && a.includes(postAuthor) && /bình luận|comment/i.test(a);
        }) || null;
        if (!commentBtn) {
          const likeBtn = allBtns.find(b => { const a = b.getAttribute('aria-label') || ''; return a.includes(postAuthor) && (a.includes('Thích') || a.includes('Gỡ')); });
          let cur = likeBtn?.parentElement;
          while (cur && cur.tagName !== 'BODY') {
            const b = cur.querySelector('div[role="button"][aria-label*="Bình luận"], div[role="button"][aria-label*="Comment"]');
            if (b) { commentBtn = b; break; }
            cur = cur.parentElement;
          }
        }
      }
      if (commentBtn) {
        scrollCenter(commentBtn);
        dispatchW3CClick(commentBtn);
        for (let i = 0; i < 15; i++) {
          await new Promise(r => setTimeout(r, 200));
          const tbs = Array.from(document.querySelectorAll('[role="textbox"][contenteditable="true"]'));
          if (tbs.length > 0) { tb = tbs[tbs.length - 1]; break; }
        }
      }
    }
    if (!tb) return { ok: false, verified: false, message: 'Không tìm thấy ô nhập bình luận' + (postAuthor ? ' (' + postAuthor + ')' : '') };
    scrollCenter(tb);
    tb.focus();
    const countComments = () => document.querySelectorAll('div[role="article"], div[aria-label*="Bình luận"], div[aria-label*="Comment by"], div[aria-label*="Bình luận dưới tên"]').length;
    const initialCount = countComments();
    writeLexicalOrEditable(tb, textToType);
    tb.dispatchEvent(new Event('input', { bubbles: true }));
    tb.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 600));
    const enterOpts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
    tb.dispatchEvent(new KeyboardEvent('keydown', enterOpts));
    tb.dispatchEvent(new KeyboardEvent('keypress', enterOpts));
    tb.dispatchEvent(new KeyboardEvent('keyup', enterOpts));
    let cur = tb.parentElement;
    for (let i = 0; i < 7; i++) {
      if (!cur) break;
      const found = cur.querySelector('div[role="button"][aria-label="Đăng bình luận"], div[role="button"][aria-label="Comment"], div[role="button"][aria-label="Post"], div[role="button"][aria-label*="Nhấn Enter để gửi"], div[role="button"][aria-label*="Press Enter to send"]');
      if (found) {
        const a = (found.getAttribute('aria-label') || '').toLowerCase();
        if (!a.startsWith('comment on') && !a.includes('comments')) { dispatchW3CClick(found); break; }
      }
      cur = cur.parentElement;
    }
    const norm = (s) => (s || '').toLowerCase().replace(/\\s+/g, ' ').trim();
    const snippet = norm(textToType).slice(0, 35);
    for (let attempt = 0; attempt < 12; attempt++) {
      await new Promise(r => setTimeout(r, 500));
      const matched = Array.from(document.querySelectorAll('div[role="article"], div[aria-label*="Bình luận"], div[aria-label*="Comment by"], div[aria-label*="Bình luận dưới tên"]'))
        .find(c => norm(c.innerText).includes(snippet));
      if (matched) return { ok: true, verified: true, message: 'Đã xác nhận bình luận xuất hiện thực tế trên Facebook!', commentSnippet: matched.innerText.slice(0, 100) };
      if (norm(tb.innerText).length === 0 && countComments() > initialCount) {
        return { ok: true, verified: true, message: 'Đã xác nhận bình luận xuất hiện thực tế trên Facebook!', commentSnippet: textToType.slice(0, 100) };
      }
    }
    return { ok: false, verified: false, message: 'Đã gửi bình luận nhưng sau 6 giây chưa thấy hiển thị trên trang.' };
  }

  async function openFbComposer(withMediaButton) {
    let triggerBtn = null;
    for (const el of document.querySelectorAll('div[role="button"], span, div, h3')) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const text = (el.innerText || '').toLowerCase();
      const hit = aria.includes('tạo bài viết') || aria.includes('viết gì đi') || aria.includes('create a post') ||
        (withMediaButton && (aria.includes('ảnh/video') || aria.includes('photo/video'))) ||
        text.includes('bạn viết gì đi') || text.includes('tạo bài viết công khai') ||
        text.includes('tạo bài viết') || text.includes('bạn đang nghĩ gì') || text.includes('write something');
      if (hit) {
        triggerBtn = el;
        if (el.getAttribute('role') === 'button') break;
      }
    }
    if (!triggerBtn) return { ok: false, message: 'Không tìm thấy nút tạo bài viết trên trang Facebook này.' };
    scrollCenter(triggerBtn);
    dispatchW3CClick(triggerBtn);

    let dialog = null;
    let tb = null;
    for (let i = 0; i < 25; i++) {
      await new Promise(r => setTimeout(r, 200));
      dialog = document.querySelector('div[role="dialog"]');
      if (dialog) {
        tb = dialog.querySelector('[role="textbox"][contenteditable="true"]');
        if (tb) break;
      }
      if (!tb) {
        const boxes = Array.from(document.querySelectorAll('[role="textbox"][contenteditable="true"]'));
        if (boxes.length > 0) { tb = boxes[boxes.length - 1]; break; }
      }
    }
    if (!tb) return { ok: false, message: 'Đã click tạo bài nhưng khung soạn thảo không mở ra.' };
    const activeContainer = dialog || tb.closest('div[role="dialog"]') || document;
    if (withMediaButton) {
      const mediaBtn = Array.from(activeContainer.querySelectorAll('div[role="button"], span[role="button"]')).find(b => {
        const a = (b.getAttribute('aria-label') || '').toLowerCase();
        const t = (b.innerText || '').toLowerCase();
        return a.includes('ảnh/video') || a.includes('photo/video') || a.includes('thêm ảnh/video') || a.includes('add photos/videos') || t.includes('ảnh/video') || t.includes('photo/video');
      });
      if (mediaBtn) {
        dispatchW3CClick(mediaBtn);
        await new Promise(r => setTimeout(r, 800));
      }
      // Đánh dấu thẻ input[type="file"] để CDP DOM.setFileInputFiles trỏ chính xác tuyệt đối
      document.querySelectorAll('[data-otter-file-target]').forEach(n => n.removeAttribute('data-otter-file-target'));
      let fileInput = activeContainer.querySelector('input[type="file"]');
      if (!fileInput) {
        const all = Array.from(document.querySelectorAll('input[type="file"]'));
        fileInput = all[all.length - 1] || null;
      }
      if (fileInput) fileInput.setAttribute('data-otter-file-target', '1');
      return { ok: true, hasFileInput: Boolean(fileInput) };
    }
    return { ok: true, hasFileInput: false };
  }

  async function finishFbPost(caption, waitMediaUpload) {
    const dialog = document.querySelector('div[role="dialog"]');
    const activeContainer = dialog || document;
    if (waitMediaUpload) {
      for (let w = 0; w < 45; w++) {
        await new Promise(r => setTimeout(r, 1000));
        const hasPreview = !!activeContainer.querySelector('video, img[src*="blob:"], [aria-label*="xóa"], [aria-label*="remove"], [aria-label*="chỉnh sửa"], [aria-label*="edit"]');
        const hasProgress = !!activeContainer.querySelector('[role="progressbar"]');
        if (hasPreview && !hasProgress) break;
      }
    }
    const tb = activeContainer.querySelector('[role="textbox"][contenteditable="true"]') ||
               Array.from(document.querySelectorAll('[role="textbox"][contenteditable="true"]')).pop();
    if (!tb) return { ok: false, verified: false, message: 'Không tìm thấy ô soạn nội dung bài viết.' };
    tb.focus();
    writeLexicalOrEditable(tb, caption);
    tb.dispatchEvent(new Event('input', { bubbles: true }));
    tb.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 1100));

    const root = tb.closest('div[role="dialog"]') || document;
    const allBtns = Array.from(root.querySelectorAll('div[role="button"], button'));
    let submitBtn = allBtns.find(b => {
      const a = (b.getAttribute('aria-label') || '').trim().toLowerCase();
      const t = (b.innerText || '').trim().toLowerCase();
      if (b.getAttribute('aria-disabled') === 'true' || b.getAttribute('disabled') !== null) return false;
      return a === 'đăng' || a === 'post' || t === 'đăng' || t === 'post';
    }) || allBtns.find(b => {
      const a = (b.getAttribute('aria-label') || '').toLowerCase();
      return (a.includes('đăng') || a.includes('post')) && b.getAttribute('aria-disabled') !== 'true';
    });
    if (!submitBtn) return { ok: false, verified: false, message: 'Không tìm thấy nút Đăng bài (hoặc nút đang bị vô hiệu hóa).' };
    dispatchW3CClick(submitBtn);

    const norm = (s) => (s || '').toLowerCase().replace(/\\s+/g, ' ').trim();
    const snippet = norm(caption).slice(0, 30);
    for (let i = 0; i < 24; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (!document.querySelector('div[role="dialog"]')) {
        return { ok: true, verified: true, message: 'Đã đăng bài viết thành công lên Facebook qua CDP!', postSnippet: caption.slice(0, 100) };
      }
      if (snippet && norm(document.body.innerText).includes(snippet)) {
        return { ok: true, verified: true, message: 'Đã đăng bài viết thành công lên Facebook qua CDP!', postSnippet: caption.slice(0, 100) };
      }
    }
    return { ok: false, verified: false, message: 'Đã click Đăng nhưng modal chưa đóng hoặc Facebook chưa xác nhận bài viết.' };
  }

  // ── 10. VISUAL ACTIVATION HUD + LIVE HOVER INSPECTOR ────────────────────────
  function injectHud(toggle) {
    if (!document.body || !document.head) return { active: false, message: 'DOM chưa sẵn sàng' };
    const HUD_ID = 'otter-activation-hud';
    const FRAME_ID = 'otter-viewport-frame';
    const INSPECTOR_ID = 'otter-hover-inspector';
    const STYLE_ID = 'otter-activation-styles';

    const cleanup = () => {
      document.getElementById(HUD_ID)?.remove();
      document.getElementById(FRAME_ID)?.remove();
      document.getElementById(INSPECTOR_ID)?.remove();
      document.getElementById(STYLE_ID)?.remove();
      if (window.__otter_hover_handler) {
        document.removeEventListener('mousemove', window.__otter_hover_handler);
        window.__otter_hover_handler = null;
      }
    };

    if (document.getElementById(HUD_ID)) {
      if (toggle) { cleanup(); return { active: false, message: 'Đã tắt Otter HUD' }; }
      return { active: true, message: 'Otter HUD đang bật' };
    }

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = '@keyframes otter-glow-pulse{0%,100%{box-shadow:inset 0 0 0 2px #10b981,inset 0 0 22px rgba(16,185,129,.28)}50%{box-shadow:inset 0 0 0 3px #059669,inset 0 0 36px rgba(16,185,129,.45)}}@keyframes otter-dot-pulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.3);opacity:.7}}';
    document.head.appendChild(style);

    const frame = document.createElement('div');
    frame.id = FRAME_ID;
    frame.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483640;animation:otter-glow-pulse 2.2s infinite ease-in-out;';
    document.body.appendChild(frame);

    const hud = document.createElement('div');
    hud.id = HUD_ID;
    hud.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);background:rgba(18,23,33,0.94);backdrop-filter:blur(10px);color:#f8fafc;padding:7px 16px;border-radius:9999px;box-shadow:0 8px 22px rgba(0,0,0,0.45),0 0 0 1px rgba(74,222,128,0.45);font-family:system-ui,-apple-system,sans-serif;font-size:12.5px;font-weight:500;display:flex;align-items:center;gap:9px;z-index:2147483647;pointer-events:auto;user-select:none;';
    hud.innerHTML = '<span style="display:inline-block;width:8px;height:8px;background:#4ade80;border-radius:50%;box-shadow:0 0 8px #4ade80;animation:otter-dot-pulse 1.5s infinite;"></span><span><strong>Otter CDP Core</strong> · Đang điều khiển</span><button id="otter-hud-close" style="background:transparent;border:none;color:#cbd5e1;font-size:16px;cursor:pointer;padding:0 3px;line-height:1;" title="Ẩn HUD">&times;</button>';
    document.body.appendChild(hud);
    hud.querySelector('#otter-hud-close')?.addEventListener('click', cleanup);

    const inspector = document.createElement('div');
    inspector.id = INSPECTOR_ID;
    inspector.style.cssText = 'position:fixed;display:none;pointer-events:none;z-index:2147483645;border:2px dashed #4ade80;background:rgba(74,222,128,0.1);border-radius:4px;transition:all 0.05s ease-out;';
    const tooltip = document.createElement('div');
    tooltip.style.cssText = 'position:absolute;bottom:calc(100% + 4px);left:0;background:#121721;color:#4ade80;font-family:ui-monospace,monospace;font-size:11px;font-weight:600;padding:2px 7px;border-radius:4px;white-space:nowrap;border:1px solid rgba(74,222,128,0.5);pointer-events:none;';
    inspector.appendChild(tooltip);
    document.body.appendChild(inspector);

    let lastTarget = null;
    const onMouseMove = (e) => {
      const target = e.target;
      if (!target || target === frame || target === hud || hud.contains(target) || target === inspector || inspector.contains(target)) {
        inspector.style.display = 'none';
        return;
      }
      if (target === lastTarget) return;
      lastTarget = target;
      const rect = target.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) { inspector.style.display = 'none'; return; }
      inspector.style.display = 'block';
      inspector.style.top = rect.top + 'px';
      inspector.style.left = rect.left + 'px';
      inspector.style.width = rect.width + 'px';
      inspector.style.height = rect.height + 'px';
      const tag = target.tagName.toLowerCase();
      const role = target.getAttribute('role');
      const info = role ? ('<' + tag + ' [' + role + ']>') : ('<' + tag + '>');
      const txt = clean(target.innerText || target.getAttribute('title') || target.getAttribute('aria-label') || '').slice(0, 24);
      tooltip.textContent = txt ? (info + ' "' + txt + '"') : info;
    };
    window.__otter_hover_handler = onMouseMove;
    document.addEventListener('mousemove', onMouseMove, { passive: true });
    return { active: true, message: 'Đã kích hoạt Otter CDP HUD' };
  }

  // ── 11. CHATGPT INJECT & MUSE AI HELPERS ────────────────────────────────────
  async function injectChatMessage(text, autoSubmit) {
    const editor = document.querySelector('#prompt-textarea') ||
                   document.querySelector('div[contenteditable="true"][data-testid="prompt-textarea"]') ||
                   document.querySelector('.ProseMirror') ||
                   document.querySelector('textarea');
    if (!editor) return { ok: false, error: 'Không tìm thấy ô soạn thảo ChatGPT (#prompt-textarea)' };
    scrollCenter(editor);
    editor.focus();
    const inserted = document.execCommand && document.execCommand('insertText', false, text);
    if (!inserted) {
      if ('value' in editor) editor.value = text;
      else editor.textContent = text;
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (!autoSubmit) return { ok: true, submitted: false };
    await new Promise(r => setTimeout(r, 350));
    const form = document.querySelector('form');
    const btn = (form && form.querySelector('button[type="submit"]')) ||
                document.querySelector('button[data-testid="send-button"]') ||
                document.querySelector('button[aria-label*="Send" i]') ||
                document.querySelector('button[aria-label*="Gửi" i]');
    if (btn && !btn.disabled) {
      dispatchW3CClick(btn);
      if (form && typeof form.requestSubmit === 'function') { try { form.requestSubmit(btn); } catch {} }
      return { ok: true, submitted: true };
    }
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    return { ok: true, submitted: true };
  }

  function museCheckReady() {
    for (const d of document.querySelectorAll('[role="dialog"], [aria-modal="true"], div[class*="modal"]')) {
      const closeBtn = d.querySelector('button[aria-label*="close" i], button[aria-label*="đóng" i], [data-testid*="close" i], [data-testid="modal-close"]');
      if (closeBtn) { try { closeBtn.click(); } catch {} }
      else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
    }
    const ta = document.querySelector('textarea');
    const body = document.body ? document.body.innerText : '';
    if (body.includes('Log in') || body.includes('Sign in') || body.includes('Đăng nhập')) return 'login_required';
    if (body.includes('Connecting...')) return 'connecting';
    if (ta && !ta.disabled) return 'ready';
    return 'loading';
  }

  async function museSend(promptText) {
    const ta = document.querySelector('textarea');
    if (!ta) return { ok: false, error: 'Không tìm thấy khung nhập tin nhắn Muse' };
    const oldBubbles = Array.from(document.querySelectorAll('div[class*="hatch-chat-groupable-bubble"], div[class*="hatch-agent-bubble-bg"], [class*="group/msg"]'))
      .filter(b => !b.closest('[class*="chat-user-bubble"]'));
    const oldBubbleCount = oldBubbles.length;
    const oldLastText = oldBubbleCount > 0 ? (oldBubbles[oldBubbleCount - 1].innerText || '').trim() : '';
    scrollCenter(ta);
    ta.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(ta, promptText); else ta.value = promptText;
    ta.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

    let sendBtn = null;
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      sendBtn = Array.from(document.querySelectorAll('button, [role="button"]')).find(b => {
        const a = (b.getAttribute('aria-label') || '').toLowerCase();
        const t = (b.innerText || '').toLowerCase();
        const tid = (b.getAttribute('data-testid') || '').toLowerCase();
        return a.includes('send') || a.includes('gửi') || t.includes('send') || t.includes('gửi') || tid.includes('send');
      }) || null;
      if (sendBtn && !sendBtn.disabled) break;
      await new Promise(r => setTimeout(r, 80));
    }
    if (sendBtn) {
      dispatchW3CClick(sendBtn);
      const form = sendBtn.closest('form');
      if (form && typeof form.requestSubmit === 'function') { try { form.requestSubmit(sendBtn); } catch {} }
    }
    await new Promise(r => setTimeout(r, 250));
    if (ta.value && ta.value.trim().length > 0) {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    }
    return { ok: true, oldBubbleCount, oldLastText };
  }

  function musePoll() {
    const scope = document.querySelector('main,[class*="chat-scroll"],[class*="hatch-chat-scroll"]') || document.body;
    const agentBubbles = Array.from(scope.querySelectorAll('div[class*="hatch-chat-groupable-bubble"], div[class*="hatch-agent-bubble-bg"], [class*="group/msg"]'))
      .filter(b => !b.closest('[class*="chat-user-bubble"]'));
    const lastBubble = agentBubbles[agentBubbles.length - 1];
    let text = lastBubble ? (lastBubble.innerText || '').trim() : '';
    if (!text) {
      const all = Array.from(document.querySelectorAll('div[class*="agent-bubble"], [data-message-author-role="assistant"]'));
      if (all.length > 0) text = (all[all.length - 1].innerText || '').trim();
    }
    const hasStop = !!document.querySelector('[data-testid="hatch-composer-stop-button"], button[aria-label*="Stop" i], button[aria-label*="停止"], button[aria-label*="Dừng" i]');
    const attachments = Array.from(document.querySelectorAll('[data-testid^="hatch-chat-attachment-presentation-"], div[class*="hatch-agent-bubble-bg"] video, div[class*="hatch-agent-bubble-bg"] img'))
      .map(el => {
        const v = el.querySelector('video') || (el.tagName === 'VIDEO' ? el : null);
        const img = el.querySelector('img') || (el.tagName === 'IMG' ? el : null);
        return { type: v ? 'video' : 'image', url: v ? (v.currentSrc || v.src) : (img ? (img.currentSrc || img.src) : '') };
      }).filter(a => !!a.url && !a.url.includes('avatar') && !a.url.includes('emoji'));
    const isOutOfCredits = /out of credits|đạt giới hạn|hết hạn ngạch/i.test(document.body ? document.body.innerText : '');
    return { bubbleCount: agentBubbles.length, text, hasStop, attachments, isOutOfCredits };
  }

  async function museExtractBlob(mediaUrl) {
    try {
      const resp = await fetch(mediaUrl);
      if (!resp.ok) return null;
      const blob = await resp.blob();
      return await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const dataUrl = reader.result;
          if (!dataUrl) return resolve(null);
          resolve({ base64: String(dataUrl).split(',')[1] || '', mime: blob.type || '', size: blob.size || 0 });
        };
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
    } catch { return null; }
  }

  window.__otterCore = {
    version: ${JSON.stringify(OTTER_CORE_VERSION)},
    readPage,
    prepClick,
    w3cClick,
    typeElement,
    selectOption,
    scrollPage,
    closeMessengerDocks,
    readComments,
    readFeed,
    reactFacebook,
    commentFacebook,
    openFbComposer,
    finishFbPost,
    injectHud,
    injectChatMessage,
    museCheckReady,
    museSend,
    musePoll,
    museExtractBlob
  };
  return { installed: true, reused: false, version: window.__otterCore.version };
})()`;
