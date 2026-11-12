// ==UserScript==
// @name         autoreger
// @namespace    http://tampermonkey.net/
// @version      5.1
// @description  Универсальный автозаполнитель форм регистрации: логин с автоинкрементом, пароль в оба поля, клик по кнопке, окно отдачи, откат при ошибках
// @match        *://*/*
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    /* ============================================================
       CONFIG — ЕДИНСТВЕННОЕ МЕСТО, КОТОРОЕ МЕНЯЕТСЯ ПОД СВОЙ САЙТ
       ============================================================ */
    const CONFIG = {
        loginSelectors: [
            'input[type="email"]',
            'input[name="email"]',
            'input[autocomplete="username"]',
            'input[name*="login"]',
            'input[id*="login"]',
        ],
        passwordSelector: 'input[type="password"]',
        submitSelector: 'button[type="submit"], input[type="submit"]',
        submitText: /create\s*account|sign\s*up|register|join|зарегистрир|создать\s*аккаунт|регистрац/i,
        signupLinkSelectors: ['a[href*="signup"]', 'a[href*="register"]', 'a[href*="registration"]'],
        signupLinkText: /create\s*an?\s*account|sign\s*up|register|регистрац/i,
        signupPagePattern: /sign[-_]?up|register|registration/i,
        signupUrl: '',
        submitDelay: 300,

        // Фразы, которые считаются ОШИБКОЙ регистрации → откат счётчика и удаление из отдачи.
        errorText: /already\s*(exists|registered|in\s*use|taken)|уже\s*(существует|зарегистрирован|занят)|\bexists\b|\btaken\b|duplicate|дубликат|invalid|неверн|некоррект|ошибк|\berror\b|failed|failure|не\s*удалось|unable|невозможн|rejected|отклонен|denied|too\s*many|слишком\s*много|captcha|каптч/i,
        // Фразы УСПЕХА — на них откат НЕ срабатывает.
        successText: /success|created|welcome|успеш|создан|добро\s*пожаловать|готово|account\s*created/i,
        // Сколько мс после клика следить за inline-ошибками в DOM.
        errorWatchMs: 12000,
    };
    /* ============================================================ */

    const hostKey = location.host;

    let template = GM_getValue('template', '');
    let current  = GM_getValue('current', template);
    let password = GM_getValue('password', '');
    let log      = GM_getValue('log', '');
    let autoNav  = GM_getValue('autoNav_' + hostKey, false);
    let hidden   = GM_getValue('hidden_' + hostKey, false);
    let lastAutoNav = 0;
    let flashTimer = null;
    let registering = false;
    let lastReg = null; // { login, pass, entry, time, rolledBack }

    function nextValue(str) {
        const at = str.indexOf('@');
        const local  = at === -1 ? str : str.slice(0, at);
        const domain = at === -1 ? ''  : str.slice(at);
        const m = local.match(/^(.*?)(\d+)(\D*)$/);
        if (m) {
            const next = String(Number(m[2]) + 1).padStart(m[2].length, '0');
            return m[1] + next + m[3] + domain;
        }
        return local + '1' + domain;
    }

    function setNativeValue(input, value) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function findLoginInput() {
        for (const sel of CONFIG.loginSelectors) {
            const el = [...document.querySelectorAll(sel)].find(i => !panel.contains(i));
            if (el) return el;
        }
        return null;
    }

    function findPasswordInputs() {
        return [...document.querySelectorAll(CONFIG.passwordSelector)].filter(i => !panel.contains(i));
    }

    function findSubmitButton() {
        const candidates = [...document.querySelectorAll(CONFIG.submitSelector)].filter(b => !panel.contains(b));
        return candidates.find(b => CONFIG.submitText.test(b.textContent || b.value || '')) || candidates[0] || null;
    }

    function findSignupLink() {
        for (const sel of CONFIG.signupLinkSelectors) {
            const el = document.querySelector(sel);
            if (el && !panel.contains(el)) return el;
        }
        return [...document.querySelectorAll('a')].find(a => !panel.contains(a) && CONFIG.signupLinkText.test(a.textContent)) || null;
    }

    function onSignupPage() {
        return CONFIG.signupPagePattern.test(location.href);
    }

    // ===== панель =====
    const style = document.createElement('style');
    style.textContent = `
        #gm-panel button, #gm-badge { transition: transform .1s ease, filter .15s ease; }
        #gm-panel button:hover, #gm-badge:hover { filter: brightness(1.15); }
        #gm-panel button:active, #gm-badge:active { transform: scale(.96); }
        #gm-panel textarea:focus { border-color: #4f46e5 !important; }
        #gm-panel::-webkit-scrollbar, #gm-panel textarea::-webkit-scrollbar { width: 8px; }
        #gm-panel::-webkit-scrollbar-track, #gm-panel textarea::-webkit-scrollbar-track { background: #111; }
        #gm-panel::-webkit-scrollbar-thumb, #gm-panel textarea::-webkit-scrollbar-thumb { background: #3a3a44; border-radius: 4px; }
        #gm-panel::-webkit-scrollbar-thumb:hover, #gm-panel textarea::-webkit-scrollbar-thumb:hover { background: #4f46e5; }
    `;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'gm-panel';
    panel.style.cssText = 'position:fixed;top:120px;right:20px;z-index:999999;background:#1c1c22;border:1px solid #3a3a44;border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px;width:250px;max-height:calc(100vh - 140px);overflow-y:auto;box-shadow:0 4px 16px rgba(0,0,0,.5);font-family:sans-serif;';
    panel.innerHTML = `
        <div style="height:3px;border-radius:2px;background:linear-gradient(90deg,#4f46e5,#22d3ee,#16a34a);"></div>
        <div style="display:flex;align-items:center;justify-content:space-between;">
            <div style="color:#e4e4ec;font-size:12px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;">autoreger</div>
            <div style="display:flex;align-items:center;gap:6px;">
                <div style="color:#6b6b76;font-size:10px;">v5.1</div>
                <button id="gm-hide" type="button" title="Скрыть панель на этом сайте"
                        style="padding:2px 8px;background:#333;color:#fff;border:0;border-radius:6px;cursor:pointer;font-size:13px;line-height:1;">–</button>
            </div>
        </div>

        <div style="color:#9a9aa5;font-size:11px;text-transform:uppercase;">Логин + пароль (2 строки)</div>
        <textarea id="gm-creds" rows="2" spellcheck="false" placeholder="login320@mail.ru&#10;пароль"
                  style="background:#111;border:1px solid #3a3a44;border-radius:6px;color:#fff;padding:8px;font-size:13px;line-height:1.45;outline:none;resize:none;font-family:inherit;"></textarea>
        <div style="display:flex;gap:6px;">
            <button id="gm-ins-login" type="button"
                    style="flex:1;padding:8px;background:#4f46e5;color:#fff;border:0;border-radius:6px;cursor:pointer;font-size:13px;">Вставить логин</button>
            <button id="gm-rst" type="button" title="Вернуть запомненное значение"
                    style="padding:8px 10px;background:#333;color:#fff;border:0;border-radius:6px;cursor:pointer;">↺</button>
        </div>
        <div id="gm-next" style="color:#9a9aa5;font-size:12px;word-break:break-all;"></div>
        <div id="gm-mem"  style="color:#6b6b76;font-size:12px;word-break:break-all;"></div>

        <button id="gm-ins-pass" type="button"
                style="padding:8px;background:#4f46e5;color:#fff;border:0;border-radius:6px;cursor:pointer;font-size:13px;">Вставить пароль (в оба поля)</button>

        <div style="border-top:1px solid #3a3a44;margin:4px 0;"></div>

        <button id="gm-ins-all" type="button"
                style="padding:9px;background:#16a34a;color:#fff;border:0;border-radius:6px;cursor:pointer;font-size:13px;font-weight:bold;">Вставить всё</button>

        <div style="border-top:1px solid #3a3a44;margin:4px 0;"></div>

        <div style="color:#9a9aa5;font-size:11px;text-transform:uppercase;">Регистрация</div>
        <button id="gm-register" type="button" title="Логин + пароль + клик по кнопке регистрации"
                style="padding:9px;background:#d97706;color:#fff;border:0;border-radius:6px;cursor:pointer;font-size:13px;font-weight:bold;">Создать аккаунт →</button>
        <label style="display:flex;align-items:center;gap:6px;color:#9a9aa5;font-size:12px;cursor:pointer;">
            <input id="gm-auto" type="checkbox" style="accent-color:#4f46e5;cursor:pointer;">
            авто-возврат на регистрацию
        </label>

        <div style="border-top:1px solid #3a3a44;margin:4px 0;"></div>

        <div id="gm-log-label" style="color:#9a9aa5;font-size:11px;text-transform:uppercase;">Отдача · 0</div>
        <textarea id="gm-log" rows="6" readonly spellcheck="false" placeholder="здесь появятся созданные аккаунты"
                  style="background:#0d0d11;border:1px solid #3a3a44;border-radius:6px;color:#d4d4dc;padding:8px;font-size:12px;line-height:1.45;outline:none;resize:vertical;font-family:monospace;"></textarea>
        <div style="display:flex;gap:6px;">
            <button id="gm-copy" type="button"
                    style="flex:1;padding:8px;background:#0ea5e9;color:#fff;border:0;border-radius:6px;cursor:pointer;font-size:13px;">Копировать</button>
            <button id="gm-clear" type="button" title="Очистить отдачу"
                    style="padding:8px 10px;background:#333;color:#fff;border:0;border-radius:6px;cursor:pointer;">✕</button>
        </div>

        <div id="gm-status" style="font-size:12px;min-height:15px;word-break:break-all;"></div>
    `;
    document.body.appendChild(panel);

    const badge = document.createElement('button');
    badge.id = 'gm-badge';
    badge.type = 'button';
    badge.textContent = '⚡ autoreger';
    badge.title = 'Показать панель';
    badge.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:999999;padding:8px 14px;background:#1c1c22;color:#e4e4ec;border:1px solid #4f46e5;border-radius:20px;cursor:pointer;font-size:12px;font-family:sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.5);display:none;';
    document.body.appendChild(badge);

    const ta        = panel.querySelector('#gm-creds');
    const nextLabel = panel.querySelector('#gm-next');
    const memLabel  = panel.querySelector('#gm-mem');
    const statusEl  = panel.querySelector('#gm-status');
    const autoChk   = panel.querySelector('#gm-auto');
    const logTa     = panel.querySelector('#gm-log');
    const logLabel  = panel.querySelector('#gm-log-label');
    autoChk.checked = autoNav;
    logTa.value = log;
    logTa.scrollTop = logTa.scrollHeight;

    function setHidden(v) {
        hidden = v;
        GM_setValue('hidden_' + hostKey, v);
        panel.style.display = v ? 'none' : 'flex';
        badge.style.display = v ? 'flex' : 'none';
    }
    setHidden(hidden);

    function syncTextarea() {
        ta.value = (current || password) ? current + '\n' + password : '';
    }
    syncTextarea();

    function flash(msg, ok = true) {
        statusEl.textContent = msg;
        statusEl.style.color = ok ? '#4ade80' : '#f87171';
        clearTimeout(flashTimer);
        flashTimer = setTimeout(() => { statusEl.textContent = ''; }, 3000);
    }

    function updateLabels() {
        nextLabel.textContent = current  ? '→ вставится: ' + current : '→ введи логин в 1-й строке';
        memLabel.textContent  = template ? '↺ сброс: ' + template    : '↺ сброс: —';
    }
    updateLabels();

    function updateLogLabel() {
        const n = log ? log.split(/\n\s*\n/).filter(s => s.trim()).length : 0;
        logLabel.textContent = 'Отдача · ' + n;
    }
    updateLogLabel();

    function appendLog(login, pass) {
        const entry = login + '\n' + pass;
        log = log ? log + '\n\n' + entry : entry;
        GM_setValue('log', log);
        logTa.value = log;
        logTa.scrollTop = logTa.scrollHeight;
        updateLogLabel();
    }

    function removeLogEntry(entry) {
        const blocks = log.split(/\n{2,}/).filter(b => b.trim());
        const idx = blocks.lastIndexOf(entry);
        if (idx === -1) return;
        blocks.splice(idx, 1);
        log = blocks.join('\n\n');
        GM_setValue('log', log);
        logTa.value = log;
        updateLogLabel();
    }

    // ===== откат при ошибке сайта =====
    function handleSiteError(text) {
        if (!lastReg || lastReg.rolledBack) return;
        if (Date.now() - lastReg.time > 30000) return;
        lastReg.rolledBack = true;

        removeLogEntry(lastReg.entry);

        let reverted = false;
        // откатываем счётчик, только если он всё ещё стоит на "оптимистичном" следующем значении
        if (current === nextValue(lastReg.login)) {
            current = lastReg.login;
            GM_setValue('current', current);
            syncTextarea();
            updateLabels();
            reverted = true;
        }
        const short = text.replace(/\s+/g, ' ').trim().slice(0, 80);
        flash('Ошибка: ' + short + (reverted ? ' — счётчик возвращён' : ' — запись удалена'), false);
    }

    function scanDomError() {
        if (!lastReg || lastReg.rolledBack) return;
        if (Date.now() - lastReg.time > CONFIG.errorWatchMs) return;
        const sels = '[role="alert"],[class*="error"],[class*="alert"],[class*="toast"],[class*="notification"],[class*="message"],[data-error]';
        for (const el of document.querySelectorAll(sels)) {
            if (panel.contains(el) || badge.contains(el)) continue;
            if (!el.getClientRects().length) continue;
            const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (txt && txt.length <= 300 && CONFIG.errorText.test(txt) && !CONFIG.successText.test(txt)) {
                handleSiteError(txt);
                return;
            }
        }
    }

    // перехват alert() сайта (как на скриншоте "User with this email already exists.")
    (function hookSiteAlerts() {
        const w = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
        try {
            const orig = w.alert;
            if (typeof orig !== 'function') return;
            w.alert = function (msg) {
                const text = String(msg == null ? '' : msg);
                if (CONFIG.errorText.test(text) && !CONFIG.successText.test(text)) {
                    handleSiteError(text);
                }
                return orig.apply(this, arguments);
            };
        } catch (e) { /* если подмена запрещена — остаётся scanDomError */ }
    })();

    ta.addEventListener('input', () => {
        const lines = ta.value.split(/\r?\n/);
        const loginLine = (lines[0] || '').trim();
        password = lines.length > 1 ? lines[1] : '';
        GM_setValue('password', password);
        if (loginLine !== current) {
            template = loginLine;
            current = loginLine;
            GM_setValue('template', template);
            GM_setValue('current', current);
        }
        updateLabels();
    });

    autoChk.addEventListener('change', () => {
        autoNav = autoChk.checked;
        GM_setValue('autoNav_' + hostKey, autoNav);
        flash(autoNav ? 'Авто-возврат включён' : 'Авто-возврат выключен');
    });

    function insertLogin(silent) {
        if (!current) { flash('Введи логин в 1-й строке', false); ta.focus(); return false; }
        const input = findLoginInput();
        if (!input) { flash('Поле логина не найдено — проверь CONFIG.loginSelectors', false); return false; }
        const value = current;
        input.focus();
        setNativeValue(input, value);
        current = nextValue(current);
        GM_setValue('current', current);
        syncTextarea();
        updateLabels();
        if (!silent) flash('Вставлено: ' + value);
        return value;
    }

    function insertPassword(silent) {
        if (!password) { flash('Введи пароль во 2-й строке', false); ta.focus(); return false; }
        const inputs = findPasswordInputs();
        if (!inputs.length) { flash('Поля пароля не найдены — проверь CONFIG.passwordSelector', false); return false; }
        inputs.forEach(i => setNativeValue(i, password));
        if (!silent) flash('Пароль вставлен в оба поля');
        return true;
    }

    function registerAccount() {
        if (registering) return;
        const usedLogin = insertLogin(true);
        if (!usedLogin) return;
        if (!insertPassword(true)) return;
        const usedPass = password;

        registering = true;
        flash('Поля заполнены, жму кнопку регистрации…');
        setTimeout(() => {
            registering = false;
            const btn = findSubmitButton();
            if (!btn) {
                // кнопка не найдена — откатываем то, что успели сделать
                current = usedLogin;
                GM_setValue('current', current);
                syncTextarea();
                updateLabels();
                flash('Кнопка не найдена — проверь CONFIG.submitSelector', false);
                return;
            }
            if (btn.disabled) {
                current = usedLogin;
                GM_setValue('current', current);
                syncTextarea();
                updateLabels();
                flash('Кнопка неактивна — проверь поля', false);
                return;
            }
            btn.click();
            appendLog(usedLogin, usedPass);
            lastReg = { login: usedLogin, pass: usedPass, entry: usedLogin + '\n' + usedPass, time: Date.now(), rolledBack: false };
            flash('Кнопка нажата ✓ жду ответ сайта…');
        }, CONFIG.submitDelay);
    }

    function goToSignup(auto) {
        const link = findSignupLink();
        if (link) {
            link.click();
            flash(auto ? 'Авто-возврат на регистрацию…' : 'Переход к регистрации…');
            return true;
        }
        if (CONFIG.signupUrl && !onSignupPage()) {
            location.href = CONFIG.signupUrl;
            return true;
        }
        if (!auto) flash('Ссылка на регистрацию не найдена', false);
        return false;
    }

    panel.querySelector('#gm-hide').addEventListener('click', () => setHidden(true));
    badge.addEventListener('click', () => setHidden(false));
    panel.querySelector('#gm-ins-login').addEventListener('click', () => insertLogin(false));
    panel.querySelector('#gm-ins-pass').addEventListener('click', () => insertPassword(false));
    panel.querySelector('#gm-ins-all').addEventListener('click', () => {
        const okL = insertLogin(true);
        const okP = insertPassword(true);
        if (okL && okP) flash('Логин и пароль вставлены ✓');
    });
    panel.querySelector('#gm-rst').addEventListener('click', () => {
        current = template;
        GM_setValue('current', current);
        syncTextarea();
        updateLabels();
        flash('Сброшено к: ' + (template || '—'));
    });
    panel.querySelector('#gm-register').addEventListener('click', registerAccount);

    panel.querySelector('#gm-copy').addEventListener('click', () => {
        if (!log) { flash('Отдача пока пустая', false); return; }
        GM_setClipboard(log, 'text');
        flash('Скопировано в буфер ✓');
    });
    panel.querySelector('#gm-clear').addEventListener('click', () => {
        if (!log) return;
        if (!confirm('Очистить отдачу?')) return;
        log = '';
        GM_setValue('log', log);
        logTa.value = '';
        updateLogLabel();
        flash('Отдача очищена');
    });

    setInterval(() => {
        if (!document.body.contains(panel)) document.body.appendChild(panel);
        if (!document.body.contains(badge)) document.body.appendChild(badge);
        scanDomError();
        if (autoNav && Date.now() - lastAutoNav > 3000 && !onSignupPage() && findSignupLink()) {
            lastAutoNav = Date.now();
            goToSignup(true);
        }
    }, 1000);
})();
