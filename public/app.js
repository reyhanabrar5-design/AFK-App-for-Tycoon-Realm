document.addEventListener('DOMContentLoaded', () => {
  const socket = io();

  let botStates = {};
  let activeBotId = null;
  let currentActiveGui = null;
  let lastRenderedGuiSig = '';

  // Three.js 3D WebGL Engine Variables
  let scene, camera, renderer, playerMesh, entityGroup, gridHelper;
  let isThreeInitialized = false;
  let isMouseDown = false, mouseX = 0, mouseY = 0;
  let cameraTargetYaw = 0, cameraTargetPitch = 0;
  let cameraCurrentYaw = 0, cameraCurrentPitch = 0;

  // Elements
  const accountTabsContainer = document.getElementById('account-tabs-container');
  const activeBotTitle = document.getElementById('active-bot-title');
  const activeBotStatusPill = document.getElementById('active-bot-status-pill');
  const activeBotStatusText = document.getElementById('active-bot-status-text');

  const btnStartSingle = document.getElementById('btn-start-single');
  const btnStopSingle = document.getElementById('btn-stop-single');
  const btnStartAll = document.getElementById('btn-start-all');
  const btnStopAll = document.getElementById('btn-stop-all');

  // Stats cards
  const cardServerHost = document.getElementById('card-server-host');
  const cardBotName = document.getElementById('card-bot-name');
  const cardHealthFood = document.getElementById('card-health-food');
  const cardCoords = document.getElementById('card-coords');

  // Scoreboard Elements
  const scoreboardTitle = document.getElementById('scoreboard-title');
  const scoreboardLines = document.getElementById('scoreboard-lines');

  // POV Viewport Scoreboard Overlay Elements
  const povSbTitle = document.getElementById('pov-sb-title');
  const povSbLines = document.getElementById('pov-sb-lines');

  // POV GUI Indicator & Modal
  const povGuiIndicator = document.getElementById('pov-gui-indicator');
  const povGuiTitle = document.getElementById('pov-gui-title');
  const btnOpenGuiModal = document.getElementById('btn-open-gui-modal');

  const guiModal = document.getElementById('gui-modal');
  const guiModalTitle = document.getElementById('gui-modal-title');
  const chestGridContainer = document.getElementById('chest-grid-container');
  const btnCloseGuiModal = document.getElementById('btn-close-gui-modal');

  // POV & Radar elements
  const povBotNameElements = document.querySelectorAll('.pov-bot-name');
  const compassArrow = document.getElementById('compass-arrow');
  const povXyz = document.getElementById('pov-xyz');
  const povYawPitch = document.getElementById('pov-yaw-pitch');
  const povDimension = document.getElementById('pov-dimension');
  const inventoryGridContainer = document.getElementById('inventory-grid-container');
  const entitiesTableBody = document.getElementById('entities-table-body');

  const threeCanvas = document.getElementById('three-canvas');
  const viewerOverlayMsg = document.getElementById('viewer-overlay-msg');

  // Console
  const terminalTitle = document.getElementById('terminal-title');
  const terminalBody = document.getElementById('terminal-body');
  const formChat = document.getElementById('form-chat');
  const inputChat = document.getElementById('input-chat');
  const btnClearLog = document.getElementById('btn-clear-log');
  const chkAutoscroll = document.getElementById('chk-autoscroll');

  // Quick Action Command Buttons
  const quickCmdBtns = document.querySelectorAll('.quick-cmd-btn');
  quickCmdBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const cmd = btn.getAttribute('data-cmd');
      if (cmd) {
        socket.emit('send-chat', { botId: activeBotId, message: cmd });
      }
    });
  });

  let userClosedGui = false;

  // Modal toggle
  if (btnOpenGuiModal) {
    btnOpenGuiModal.addEventListener('click', () => {
      userClosedGui = false;
      if (guiModal) guiModal.classList.remove('hidden');
    });
  }

  if (btnCloseGuiModal) {
    btnCloseGuiModal.addEventListener('click', () => {
      userClosedGui = true;
      closeGuiModalUI();
      if (activeBotId) {
        socket.emit('close-gui-modal', activeBotId);
      }
    });
  }

  // Settings
  const settingBotTitle = document.getElementById('setting-bot-title');
  const settingScriptTitle = document.getElementById('setting-script-title');

  const formSettingsConn = document.getElementById('form-settings-connection');
  const formSettingsScript = document.getElementById('form-settings-script');

  // Navigation
  const navItems = document.querySelectorAll('.nav-item');
  const tabContents = document.querySelectorAll('.tab-content');
  const tabTitle = document.getElementById('tab-title');
  const tabSubtitle = document.getElementById('tab-subtitle');

  const tabInfoMap = {
    dashboard: { title: 'Dashboard Multi-Bot AFK', subtitle: 'Kelola 4 akun Minecraft AFK, Scoreboard Sidebar & Tampilan Kamera 3D POV' },
    pov: { title: 'Live 3D POV & World Radar', subtitle: 'Pantau kamera 3D pandangan mata karakter, kompas, inventory & entitas' },
    settings: { title: 'Pengaturan Bot', subtitle: 'Kustomisasi koneksi dan skrip perintah otomatis tiap akun' }
  };

  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const tabName = item.getAttribute('data-tab');

      navItems.forEach(n => n.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));

      item.classList.add('active');
      const targetTab = document.getElementById(`tab-${tabName}`);
      if (targetTab) targetTab.classList.add('active');

      if (tabInfoMap[tabName]) {
        tabTitle.textContent = tabInfoMap[tabName].title;
        tabSubtitle.textContent = tabInfoMap[tabName].subtitle;
      }

      if (tabName === 'pov') {
        initThreeJSViewer();
      }
    });
  });

  // Mobile sidebar toggle
  const mobileToggle = document.getElementById('mobile-toggle');
  const sidebar = document.querySelector('.sidebar');
  if (mobileToggle) {
    mobileToggle.addEventListener('click', () => sidebar.classList.toggle('open'));
  }

  // Init Three.js 3D Engine
  function initThreeJSViewer() {
    if (isThreeInitialized || !window.THREE || !threeCanvas) return;
    isThreeInitialized = true;

    const wrapper = document.getElementById('viewer-3d-wrapper');
    const width = wrapper.clientWidth || 600;
    const height = wrapper.clientHeight || 440;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0f1d);
    scene.fog = new THREE.FogExp2(0x0a0f1d, 0.015);

    camera = new THREE.PerspectiveCamera(70, width / height, 0.1, 1000);
    camera.position.set(0, 3, 5);

    renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0x6366f1, 1.2);
    dirLight.position.set(10, 20, 15);
    scene.add(dirLight);

    gridHelper = new THREE.GridHelper(60, 60, 0x6366f1, 0x1e293b);
    gridHelper.position.y = 0;
    scene.add(gridHelper);

    const playerGroup = new THREE.Group();

    const bodyGeo = new THREE.BoxGeometry(0.8, 1.2, 0.5);
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x6366f1, roughness: 0.3 });
    const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
    bodyMesh.position.y = 1;
    playerGroup.add(bodyMesh);

    const headGeo = new THREE.BoxGeometry(0.6, 0.6, 0.6);
    const headMat = new THREE.MeshStandardMaterial({ color: 0x38bdf8, roughness: 0.2 });
    const headMesh = new THREE.Mesh(headGeo, headMat);
    headMesh.position.y = 1.9;
    playerGroup.add(headMesh);

    const eyeGeo = new THREE.BoxGeometry(0.4, 0.15, 0.2);
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0x4ade80 });
    const eyeMesh = new THREE.Mesh(eyeGeo, eyeMat);
    eyeMesh.position.set(0, 1.95, -0.3);
    playerGroup.add(eyeMesh);

    playerMesh = playerGroup;
    scene.add(playerMesh);

    entityGroup = new THREE.Group();
    scene.add(entityGroup);

    threeCanvas.addEventListener('mousedown', (e) => {
      isMouseDown = true;
      mouseX = e.clientX;
      mouseY = e.clientY;
    });

    window.addEventListener('mouseup', () => isMouseDown = false);

    window.addEventListener('mousemove', (e) => {
      if (!isMouseDown) return;
      const deltaX = e.clientX - mouseX;
      const deltaY = e.clientY - mouseY;
      mouseX = e.clientX;
      mouseY = e.clientY;

      cameraTargetYaw += deltaX * 0.008;
      cameraTargetPitch += deltaY * 0.008;
      cameraTargetPitch = Math.max(-1.2, Math.min(1.2, cameraTargetPitch));
    });

    window.addEventListener('resize', () => {
      if (!wrapper) return;
      const w = wrapper.clientWidth;
      const h = wrapper.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });

    function animate() {
      requestAnimationFrame(animate);

      cameraCurrentYaw += (cameraTargetYaw - cameraCurrentYaw) * 0.1;
      cameraCurrentPitch += (cameraTargetPitch - cameraCurrentPitch) * 0.1;

      const dist = 4.5;
      camera.position.x = playerMesh.position.x + Math.sin(cameraCurrentYaw) * dist * Math.cos(cameraCurrentPitch);
      camera.position.z = playerMesh.position.z + Math.cos(cameraCurrentYaw) * dist * Math.cos(cameraCurrentPitch);
      camera.position.y = playerMesh.position.y + 1.8 + Math.sin(cameraCurrentPitch) * dist;

      camera.lookAt(playerMesh.position.x, playerMesh.position.y + 1.5, playerMesh.position.z);

      renderer.render(scene, camera);
    }
    animate();
  }

  // Socket Events
  socket.on('init-multi', (allStates) => {
    botStates = {};
    if (Array.isArray(allStates)) {
      allStates.forEach(state => {
        botStates[state.config.id] = state;
      });
    }

    if (!botStates[activeBotId]) {
      activeBotId = Object.keys(botStates)[0] || null;
    }

    renderAccountTabs();
    renderActiveBotUI();
  });

  socket.on('account-added', (state) => {
    botStates[state.config.id] = state;
    activeBotId = state.config.id;
    renderAccountTabs();
    renderActiveBotUI();
  });

  socket.on('account-removed', (data) => {
    delete botStates[data.botId];
    if (activeBotId === data.botId) {
      activeBotId = Object.keys(botStates)[0] || null;
    }
    renderAccountTabs();
    renderActiveBotUI();
  });

  socket.on('account-error', (data) => {
    alert(data.message || 'Terjadi kesalahan pada akun!');
  });

  socket.on('bot-msa-code', (data) => {
    const msaModal = document.getElementById('msa-code-modal');
    const msaCodeVal = document.getElementById('msa-code-value');
    const msaLink = document.getElementById('msa-verification-link');
    const btnCopyMsa = document.getElementById('btn-copy-msa-code');

    if (msaCodeVal) msaCodeVal.textContent = data.userCode || '--------';
    if (msaLink && data.verificationUri) {
      msaLink.href = data.verificationUri;
      msaLink.textContent = data.verificationUri;
    }
    if (msaModal) msaModal.classList.remove('hidden');

    if (btnCopyMsa) {
      btnCopyMsa.onclick = () => {
        navigator.clipboard.writeText(data.userCode);
        alert(`Kode otentikasi ${data.userCode} berhasil disalin!`);
      };
    }
  });

  const btnCloseMsaModal = document.getElementById('btn-close-msa-modal');
  if (btnCloseMsaModal) {
    btnCloseMsaModal.addEventListener('click', () => {
      const msaModal = document.getElementById('msa-code-modal');
      if (msaModal) msaModal.classList.add('hidden');
    });
  }

  socket.on('bot-status-update', (data) => {
    if (botStates[data.botId]) {
      botStates[data.botId].status = data.status;
      if (data.health) botStates[data.botId].health = data.health;
      if (data.position) botStates[data.botId].position = data.position;
      if (data.scoreboard) botStates[data.botId].scoreboard = data.scoreboard;
      if (data.config) botStates[data.botId].config = data.config;
      if (data.activeGui !== undefined) botStates[data.botId].activeGui = data.activeGui;
    }
    renderAccountTabs();
    if (data.botId === activeBotId) {
      renderActiveBotUI();
    }
  });

  socket.on('bot-health-update', (data) => {
    if (botStates[data.botId]) {
      botStates[data.botId].health = data.health;
    }
    if (data.botId === activeBotId) {
      updateHealthUI(data.health);
    }
  });

  socket.on('bot-spatial-update', (data) => {
    if (botStates[data.botId]) {
      botStates[data.botId].position = data.position;
      botStates[data.botId].scoreboard = data.scoreboard;
      botStates[data.botId].inventory = data.inventory;
      botStates[data.botId].entities = data.entities;
      if (data.activeGui !== undefined) botStates[data.botId].activeGui = data.activeGui;
    }
    if (data.botId === activeBotId) {
      updateSpatialUI(data.position, data.scoreboard, data.inventory, data.entities);
      if (data.activeGui) renderGuiModal(data.activeGui);
    }
  });

  socket.on('bot-gui-open', (data) => {
    userClosedGui = false;
    if (botStates[data.botId]) {
      botStates[data.botId].activeGui = data.gui;
    }
    if (data.botId === activeBotId) {
      renderGuiModal(data.gui);
    }
  });

  socket.on('bot-gui-close', (data) => {
    userClosedGui = false;
    if (botStates[data.botId]) {
      botStates[data.botId].activeGui = null;
    }
    if (data.botId === activeBotId) {
      closeGuiModalUI();
    }
  });

  socket.on('bot-log', (data) => {
    if (botStates[data.botId]) {
      botStates[data.botId].logs.push(data.log);
      if (botStates[data.botId].logs.length > 150) {
        botStates[data.botId].logs.shift();
      }
    }
    if (data.botId === activeBotId) {
      appendLogEntry(data.log);
    }
  });

  socket.on('bot-config-updated', (data) => {
    if (botStates[data.botId]) {
      botStates[data.botId].config = data.config;
    }
    renderAccountTabs();
    if (data.botId === activeBotId) {
      populateSettings(data.config);
    }
  });

  // Action Buttons
  btnStartSingle.addEventListener('click', () => socket.emit('start-bot', activeBotId));
  btnStopSingle.addEventListener('click', () => socket.emit('stop-bot', activeBotId));
  btnStartAll.addEventListener('click', () => socket.emit('start-all-bots'));
  btnStopAll.addEventListener('click', () => socket.emit('stop-all-bots'));

  formChat.addEventListener('submit', (e) => {
    e.preventDefault();
    const msg = inputChat.value.trim();
    if (msg) {
      socket.emit('send-chat', { botId: activeBotId, message: msg });
      inputChat.value = '';
    }
  });

  btnClearLog.addEventListener('click', () => {
    if (botStates[activeBotId]) botStates[activeBotId].logs = [];
    terminalBody.innerHTML = '';
  });

  formSettingsConn.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!activeBotId || !botStates[activeBotId]) return;

    const updated = {
      username: document.getElementById('cfg-username').value.trim(),
      host: document.getElementById('cfg-host').value.trim(),
      port: parseInt(document.getElementById('cfg-port').value.trim() || '25565'),
      version: document.getElementById('cfg-version').value,
      auth: document.getElementById('cfg-auth').value,
      password: document.getElementById('cfg-password') ? document.getElementById('cfg-password').value.trim() : (botStates[activeBotId].config.password || ''),
      autoReconnect: document.getElementById('cfg-reconnect').checked,
    };

    socket.emit('update-bot-config', { botId: activeBotId, newConfig: updated });
    alert(`Pengaturan akun ${activeBotId} berhasil disimpan!`);
  });

  let currentAutoCmdRows = [];

  function renderAutoCmdRows(cmds) {
    const container = document.getElementById('auto-cmd-container');
    if (!container) return;

    if (Array.isArray(cmds) && cmds.length > 0) {
      currentAutoCmdRows = cmds.map((item, idx) => {
        if (typeof item === 'string') {
          return { cmd: item, delaySec: 2 };
        } else if (typeof item === 'object' && item !== null) {
          return {
            cmd: item.cmd || '',
            delaySec: typeof item.delaySec === 'number' ? item.delaySec : (parseInt(item.delaySec) || 2)
          };
        }
        return { cmd: '', delaySec: 2 };
      });
    } else {
      currentAutoCmdRows = [
        { cmd: '/login {password}', delaySec: 2 },
        { cmd: '/server tycoon', delaySec: 2 },
        { cmd: '/is', delaySec: 2 }
      ];
    }

    if (!activeBotId || !botStates[activeBotId]) {
      container.innerHTML = `
        <div class="empty-cmd-hint" style="text-align: center; color: var(--text-muted); padding: 1.5rem; font-size: 0.88rem; background: rgba(255,255,255,0.03); border-radius: var(--radius-sm); border: 1px dashed var(--border-color);">
          <i class="fa-solid fa-circle-info" style="color: var(--accent-info); font-size: 1.2rem; margin-bottom: 0.4rem; display: block;"></i>
          Silakan pilih akun bot di tab atas atau buat akun baru untuk mengatur perintah otomatis.
        </div>
      `;
      return;
    }

    container.innerHTML = '';

    currentAutoCmdRows.forEach((row, idx) => {
      const stepNum = idx + 1;
      const rowDiv = document.createElement('div');
      rowDiv.className = 'cmd-box-row';

      rowDiv.innerHTML = `
        <div class="cmd-header-row">
          <div class="cmd-title-wrap">
            <span class="cmd-step-badge">${stepNum}</span>
            <span>Perintah #${stepNum}</span>
          </div>
          <div class="cmd-right-controls">
            <div class="delay-input-wrap">
              <span>Jeda:</span>
              <input type="number" class="cmd-delay-input" min="0" step="1" value="${row.delaySec || 2}" data-idx="${idx}">
              <span>detik</span>
            </div>
            ${currentAutoCmdRows.length > 1 ? `<button type="button" class="btn-remove-cmd" data-idx="${idx}" title="Hapus perintah ini"><i class="fa-solid fa-trash"></i></button>` : ''}
          </div>
        </div>
        <div class="input-with-icon">
          <i class="fa-solid fa-terminal input-icon"></i>
          <input type="text" class="form-control cmd-input" value="${row.cmd || ''}" placeholder="Contoh: /server tycoon atau server tycoon" data-idx="${idx}">
        </div>
      `;

      container.appendChild(rowDiv);
    });

    container.querySelectorAll('.cmd-input').forEach(input => {
      input.addEventListener('input', (e) => {
        const i = parseInt(e.target.getAttribute('data-idx'));
        if (currentAutoCmdRows[i]) {
          currentAutoCmdRows[i].cmd = e.target.value;
        }
      });
    });

    container.querySelectorAll('.cmd-delay-input').forEach(input => {
      input.addEventListener('input', (e) => {
        const i = parseInt(e.target.getAttribute('data-idx'));
        const val = parseInt(e.target.value) || 0;
        if (currentAutoCmdRows[i]) {
          currentAutoCmdRows[i].delaySec = val;
        }
      });
    });

    container.querySelectorAll('.btn-remove-cmd').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const i = parseInt(btn.getAttribute('data-idx'));
        currentAutoCmdRows.splice(i, 1);
        renderAutoCmdRows(currentAutoCmdRows);
      });
    });
  }

  const btnAddCmd = document.getElementById('btn-add-cmd');
  if (btnAddCmd) {
    btnAddCmd.addEventListener('click', () => {
      currentAutoCmdRows.push({ cmd: '', delaySec: 2 });
      renderAutoCmdRows(currentAutoCmdRows);
      const container = document.getElementById('auto-cmd-container');
      if (container) {
        const inputs = container.querySelectorAll('.cmd-input');
        if (inputs.length > 0) {
          inputs[inputs.length - 1].focus();
        }
      }
    });
  }

  // Settings Forms & Auth Handlers
  if (formSettingsConn) {
    formSettingsConn.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!activeBotId || !botStates[activeBotId]) return;

      const cfgUsername = document.getElementById('cfg-username');
      const cfgHost = document.getElementById('cfg-host');
      const cfgPort = document.getElementById('cfg-port');
      const cfgVersion = document.getElementById('cfg-version');
      const cfgAuth = document.getElementById('cfg-auth');
      const cfgPassword = document.getElementById('cfg-password');
      const cfgReconnect = document.getElementById('cfg-reconnect');

      const updated = {
        username: cfgUsername ? cfgUsername.value.trim() : '',
        host: cfgHost ? cfgHost.value.trim() : 'alwination.id',
        port: cfgPort ? parseInt(cfgPort.value) || 25565 : 25565,
        version: cfgVersion ? cfgVersion.value : 'auto',
        auth: cfgAuth ? cfgAuth.value : 'offline',
        password: cfgPassword ? cfgPassword.value.trim() : '',
        autoReconnect: cfgReconnect ? cfgReconnect.checked : true
      };

      socket.emit('update-bot-config', { botId: activeBotId, newConfig: updated });
      alert(`Pengaturan akun untuk ${activeBotId} berhasil disimpan!`);
    });
  }

  const formSettingsSecurity = document.getElementById('form-settings-security');
  const cfgSecurityEnabled = document.getElementById('cfg-security-enabled');
  const cfgSecurityPassword = document.getElementById('cfg-security-password');
  const btnToggleSecPass = document.getElementById('btn-toggle-sec-pass');
  const eyeSecPass = document.getElementById('eye-sec-pass');

  if (btnToggleSecPass && cfgSecurityPassword && eyeSecPass) {
    btnToggleSecPass.addEventListener('click', () => {
      if (cfgSecurityPassword.type === 'password') {
        cfgSecurityPassword.type = 'text';
        eyeSecPass.classList.remove('fa-eye');
        eyeSecPass.classList.add('fa-eye-slash');
      } else {
        cfgSecurityPassword.type = 'password';
        eyeSecPass.classList.remove('fa-eye-slash');
        eyeSecPass.classList.add('fa-eye');
      }
    });
  }

  if (formSettingsSecurity) {
    formSettingsSecurity.addEventListener('submit', (e) => {
      e.preventDefault();
      const enabled = cfgSecurityEnabled ? cfgSecurityEnabled.checked : false;
      const pwd = cfgSecurityPassword ? cfgSecurityPassword.value.trim() : '';

      const payload = { enabled };
      if (pwd.length > 0) {
        payload.password = pwd;
      }

      socket.emit('update-security-config', payload);
      alert('Pengaturan Keamanan Dashboard berhasil disimpan!');
    });
  }

  const authOverlay = document.getElementById('auth-overlay');
  const formAuthLogin = document.getElementById('form-auth-login');
  const authPasswordInput = document.getElementById('auth-password-input');
  const authErrorMsg = document.getElementById('auth-error-msg');
  const authErrorText = document.getElementById('auth-error-text');
  const btnToggleAuthPass = document.getElementById('btn-toggle-auth-pass');
  const eyeAuthPass = document.getElementById('eye-auth-pass');
  const btnLockDashboard = document.getElementById('btn-lock-dashboard');
  const secStatusText = document.getElementById('sec-status-text');

  if (btnToggleAuthPass && authPasswordInput && eyeAuthPass) {
    btnToggleAuthPass.addEventListener('click', () => {
      if (authPasswordInput.type === 'password') {
        authPasswordInput.type = 'text';
        eyeAuthPass.classList.remove('fa-eye');
        eyeAuthPass.classList.add('fa-eye-slash');
      } else {
        authPasswordInput.type = 'password';
        eyeAuthPass.classList.remove('fa-eye-slash');
        eyeAuthPass.classList.add('fa-eye');
      }
    });
  }

  if (formAuthLogin) {
    formAuthLogin.addEventListener('submit', (e) => {
      e.preventDefault();
      const password = authPasswordInput ? authPasswordInput.value : '';
      socket.emit('verify-password', { password });
    });
  }

  if (btnLockDashboard) {
    btnLockDashboard.addEventListener('click', () => {
      const savedToken = localStorage.getItem('afk_dashboard_token');
      localStorage.removeItem('afk_dashboard_token');
      socket.emit('lock-session', savedToken);
    });
  }

  socket.on('auth-status', (data) => {
    const isAuth = data && data.authenticated;
    const isSecEnabled = data && data.securityEnabled;

    if (secStatusText) {
      if (isSecEnabled) {
        secStatusText.textContent = 'AKTIF (Dashboard Dilindungi Password)';
        secStatusText.className = 'badge-enabled';
        if (cfgSecurityEnabled) cfgSecurityEnabled.checked = true;
      } else {
        secStatusText.textContent = 'NON-AKTIF (Akses Terbuka)';
        secStatusText.className = 'badge-disabled';
        if (cfgSecurityEnabled) cfgSecurityEnabled.checked = false;
      }
    }

    if (!isAuth && isSecEnabled) {
      if (authOverlay) authOverlay.classList.remove('hidden');
    } else {
      if (authOverlay) authOverlay.classList.add('hidden');
    }
  });

  socket.on('auth-success', (data) => {
    if (data && data.token) {
      localStorage.setItem('afk_dashboard_token', data.token);
    }
    if (authOverlay) authOverlay.classList.add('hidden');
    if (authErrorMsg) authErrorMsg.classList.add('hidden');
    if (authPasswordInput) authPasswordInput.value = '';
  });

  socket.on('auth-failed', (data) => {
    if (authErrorMsg) authErrorMsg.classList.remove('hidden');
    if (authErrorText) authErrorText.textContent = (data && data.message) || 'Kata sandi salah!';
  });

  socket.on('security-config-updated', (data) => {
    if (data) {
      const isSecEnabled = !!data.enabled;
      if (secStatusText) {
        if (isSecEnabled) {
          secStatusText.textContent = 'AKTIF (Dashboard Dilindungi Password)';
          secStatusText.className = 'badge-enabled';
        } else {
          secStatusText.textContent = 'NON-AKTIF (Akses Terbuka)';
          secStatusText.className = 'badge-disabled';
        }
      }
    }
  });

  const initialToken = localStorage.getItem('afk_dashboard_token');
  if (initialToken) {
    socket.emit('check-auth', initialToken);
  }

  if (formSettingsScript) {
    formSettingsScript.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!activeBotId || !botStates[activeBotId]) return;

      const scriptLines = [];
      currentAutoCmdRows.forEach((row) => {
        const c = (row.cmd || '').trim();
        const delaySec = typeof row.delaySec === 'number' ? row.delaySec : (parseInt(row.delaySec) || 2);
        if (c) {
          const waitUnits = delaySec * 20;
          if (scriptLines.length > 0) {
            scriptLines.push(`wait ${waitUnits}`);
          }
          let formattedCmd = c;
          if (!formattedCmd.toLowerCase().startsWith('send ')) {
            if (!formattedCmd.startsWith('/')) formattedCmd = '/' + formattedCmd;
            formattedCmd = 'send ' + formattedCmd;
          }
          scriptLines.push(formattedCmd);
        }
      });

      const updated = {
        scriptEnabled: document.getElementById('cfg-script-enabled').checked,
        autoCmds: currentAutoCmdRows,
        scriptText: scriptLines.join('\n')
      };

      socket.emit('update-bot-config', { botId: activeBotId, newConfig: updated });
      alert(`Pengaturan perintah otomatis untuk ${activeBotId} berhasil disimpan!`);
    });
  }

  // Modal Tambah Akun Elements & Logic
  const addAccountModal = document.getElementById('add-account-modal');
  const btnCloseAddModal = document.getElementById('btn-close-add-modal');
  const btnCancelAddModal = document.getElementById('btn-cancel-add-modal');
  const btnAddAccountEmpty = document.getElementById('btn-add-account-empty');
  const formAddAccount = document.getElementById('form-add-account');
  const cardTypeCracked = document.getElementById('card-type-cracked');
  const cardTypePremium = document.getElementById('card-type-premium');
  const addUsernameInput = document.getElementById('add-username');
  const addPasswordInput = document.getElementById('add-password');
  const btnToggleAddPass = document.getElementById('btn-toggle-add-pass');
  const eyeAddPass = document.getElementById('eye-add-pass');
  const lblAddUsername = document.getElementById('lbl-add-username');
  const hintAddPassword = document.getElementById('hint-add-password');
  const btnDeleteAccount = document.getElementById('btn-delete-account');

  let selectedAddType = 'cracked';
  let selectedPlatform = 'java';

  const cardPlatformJava = document.getElementById('card-platform-java');
  const cardPlatformBedrock = document.getElementById('card-platform-bedrock');
  const addPortInput = document.getElementById('add-port');

  if (cardPlatformJava && cardPlatformBedrock) {
    cardPlatformJava.addEventListener('click', () => {
      selectedPlatform = 'java';
      cardPlatformJava.classList.add('active');
      cardPlatformBedrock.classList.remove('active');
      if (addPortInput) addPortInput.value = '25565';
    });

    cardPlatformBedrock.addEventListener('click', () => {
      selectedPlatform = 'bedrock';
      cardPlatformBedrock.classList.add('active');
      cardPlatformJava.classList.remove('active');
      if (addPortInput) addPortInput.value = '19132';
    });
  }

  function openAddAccountModal() {
    if (addAccountModal) addAccountModal.classList.remove('hidden');
    if (addUsernameInput) setTimeout(() => addUsernameInput.focus(), 150);
  }

  function closeAddAccountModal() {
    if (addAccountModal) addAccountModal.classList.add('hidden');
  }

  if (btnCloseAddModal) btnCloseAddModal.addEventListener('click', closeAddAccountModal);
  if (btnCancelAddModal) btnCancelAddModal.addEventListener('click', closeAddAccountModal);
  if (btnAddAccountEmpty) btnAddAccountEmpty.addEventListener('click', openAddAccountModal);

  if (cardTypeCracked && cardTypePremium) {
    cardTypeCracked.addEventListener('click', () => {
      selectedAddType = 'cracked';
      cardTypeCracked.classList.add('active');
      cardTypePremium.classList.remove('active');
      if (lblAddUsername) lblAddUsername.textContent = 'Username Minecraft';
      if (addUsernameInput) addUsernameInput.placeholder = 'Contoh: sasori_player';
      if (hintAddPassword) hintAddPassword.textContent = 'Dipakai otomatis pada perintah `/login <password>` saat bot masuk server.';
    });

    cardTypePremium.addEventListener('click', () => {
      selectedAddType = 'premium';
      cardTypePremium.classList.add('active');
      cardTypeCracked.classList.remove('active');
      if (lblAddUsername) lblAddUsername.textContent = 'Email / Username Microsoft';
      if (addUsernameInput) addUsernameInput.placeholder = 'Contoh: player@outlook.com atau IGN';
      if (hintAddPassword) hintAddPassword.textContent = 'Password opsional. Otentikasi Microsoft dilakukan via kode browser Microsoft Device Link.';
    });
  }

  if (btnToggleAddPass && addPasswordInput && eyeAddPass) {
    btnToggleAddPass.addEventListener('click', () => {
      if (addPasswordInput.type === 'password') {
        addPasswordInput.type = 'text';
        eyeAddPass.classList.remove('fa-eye');
        eyeAddPass.classList.add('fa-eye-slash');
      } else {
        addPasswordInput.type = 'password';
        eyeAddPass.classList.remove('fa-eye-slash');
        eyeAddPass.classList.add('fa-eye');
      }
    });
  }

  if (formAddAccount) {
    formAddAccount.addEventListener('submit', (e) => {
      e.preventDefault();
      const username = addUsernameInput ? addUsernameInput.value.trim() : '';
      const password = addPasswordInput ? addPasswordInput.value.trim() : '';
      const host = document.getElementById('add-host') ? document.getElementById('add-host').value.trim() : 'alwination.id';
      const port = document.getElementById('add-port') ? document.getElementById('add-port').value.trim() : '25565';
      const targetServer = document.getElementById('add-target-server') ? document.getElementById('add-target-server').value.trim() : 'tycoon';
      const nextCmd = document.getElementById('add-next-cmd') ? document.getElementById('add-next-cmd').value.trim() : '/is';

      if (!username) {
        alert('Username / Email wajib diisi!');
        return;
      }

      socket.emit('add-account', {
        platform: selectedPlatform,
        type: selectedAddType,
        username,
        password,
        host,
        port,
        targetServer,
        nextCmd
      });

      closeAddAccountModal();
      if (addUsernameInput) addUsernameInput.value = '';
      if (addPasswordInput) addPasswordInput.value = '';
    });
  }

  if (btnDeleteAccount) {
    btnDeleteAccount.addEventListener('click', () => {
      if (!activeBotId || !botStates[activeBotId]) return;
      const username = botStates[activeBotId].config.username;
      if (confirm(`Apakah Anda yakin ingin menghapus akun "${username}"?`)) {
        socket.emit('remove-account', activeBotId);
      }
    });
  }

  // Render Functions
  function renderAccountTabs() {
    if (!accountTabsContainer) return;
    accountTabsContainer.innerHTML = '';

    const botIds = Object.keys(botStates);
    const emptyBanner = document.getElementById('empty-accounts-banner');

    if (botIds.length === 0) {
      activeBotId = null;
      if (emptyBanner) emptyBanner.classList.remove('hidden');
    } else {
      if (emptyBanner) emptyBanner.classList.add('hidden');
      if (!activeBotId || !botStates[activeBotId]) {
        activeBotId = botIds[0];
      }
    }

    botIds.forEach(botId => {
      const state = botStates[botId];
      const tab = document.createElement('div');
      tab.className = `account-tab-item ${botId === activeBotId ? 'active' : ''}`;
      const isBedrock = state.config && state.config.platform === 'bedrock';
      const platformIcon = isBedrock
        ? '<i class="fa-solid fa-cube" style="color:#38bdf8; margin-right: 4px;" title="Bedrock Edition"></i>'
        : '<i class="fa-solid fa-mug-hot" style="color:#a7f3d0; margin-right: 4px;" title="Java Edition"></i>';
      const authIcon = state.config && state.config.auth === 'microsoft' ? '<i class="fa-solid fa-crown" style="color:#fbbf24; margin-left: 4px;" title="Akun Premium"></i>' : '';
      tab.innerHTML = `
        <span class="status-dot ${state.status}"></span>
        ${platformIcon}
        <span class="account-tab-name">${state.config.username}</span>
        ${authIcon}
      `;
      tab.addEventListener('click', () => {
        activeBotId = botId;
        renderAccountTabs();
        renderActiveBotUI();
      });
      accountTabsContainer.appendChild(tab);
    });

    const addBtn = document.createElement('button');
    addBtn.className = 'btn-add-account-tab';
    addBtn.id = 'btn-open-add-account';
    addBtn.innerHTML = `<i class="fa-solid fa-plus"></i> <span>Tambah Akun</span>`;
    addBtn.addEventListener('click', openAddAccountModal);
    accountTabsContainer.appendChild(addBtn);
  }



  function renderActiveBotUI() {
    const state = botStates[activeBotId];
    if (!state) return;

    const cfg = state.config;

    activeBotTitle.textContent = `Akun: ${cfg.username}`;
    terminalTitle.textContent = `Live Console Log - ${cfg.username}`;
    settingBotTitle.textContent = cfg.username;
    settingScriptTitle.textContent = cfg.username;

    povBotNameElements.forEach(el => el.textContent = cfg.username);

    // Status Pill
    activeBotStatusPill.className = `status-pill ${state.status}`;
    activeBotStatusText.textContent = state.status.toUpperCase();

    if (state.status === 'online') {
      btnStartSingle.style.display = 'none';
      btnStopSingle.style.display = 'inline-flex';
      if (viewerOverlayMsg) viewerOverlayMsg.classList.add('hidden');
    } else if (state.status === 'connecting') {
      btnStartSingle.style.display = 'none';
      btnStopSingle.style.display = 'inline-flex';
      if (viewerOverlayMsg) viewerOverlayMsg.classList.remove('hidden');
    } else {
      btnStartSingle.style.display = 'inline-flex';
      btnStopSingle.style.display = 'none';
      if (viewerOverlayMsg) viewerOverlayMsg.classList.remove('hidden');
    }

    // Cards
    cardServerHost.textContent = `${cfg.host}:${cfg.port}`;
    cardBotName.textContent = cfg.username;

    updateHealthUI(state.health);
    updateSpatialUI(state.position, state.scoreboard, state.inventory, state.entities);
    if (state.activeGui) {
      renderGuiModal(state.activeGui);
    } else {
      closeGuiModalUI();
    }
    populateSettings(cfg);

    // Logs & 3D POV Live Chat Overlay
    terminalBody.innerHTML = '';
    if (state.logs && Array.isArray(state.logs)) {
      state.logs.forEach(appendLogEntry);
      renderPovChatOverlay(state.logs);
    }
  }

  function updateHealthUI(health) {
    const h = health && health.health !== undefined ? health.health : 20;
    const f = health && health.food !== undefined ? health.food : 20;
    cardHealthFood.textContent = `${h} ❤ / ${f} 🍖`;
  }

  function cleanLineText(text) {
    if (!text) return '';
    let str = String(text);
    str = str.replace(/TAB-Sidebar-\d+/gi, '');
    str = str.replace(/TAB-\w+-\d+/gi, '');
    str = str.replace(/§[0-9a-fk-or]/gi, '');
    str = str.replace(/^\|\s*\|/g, '|');
    return str.trim();
  }

  // Minecraft Item Texture CDN & Mapper Helper
  function getItemTextureUrl(name, displayName) {
    if (!name || name === 'air') return '';
    let clean = String(name).toLowerCase().trim().replace(/^minecraft:/, '');
    let display = displayName ? String(displayName).toLowerCase() : '';

    // Determine block vs item texture directory
    let isBlock = clean.includes('glass') || clean.includes('pane') || clean.includes('block') || clean.includes('obsidian') || clean.includes('stone') || clean.includes('chest') || clean.includes('beacon') || clean.includes('wool') || clean.includes('terracotta') || clean.includes('concrete') || clean.includes('anvil');

    // Alias & custom server item mapping
    if (clean.includes('netherit') || display.includes('netherit')) {
      isBlock = false;
      if (display.includes('sword')) clean = 'netherite_sword';
      else if (display.includes('pickaxe')) clean = 'netherite_pickaxe';
      else if (display.includes('axe')) clean = 'netherite_axe';
      else if (display.includes('shovel')) clean = 'netherite_shovel';
      else if (display.includes('helmet')) clean = 'netherite_helmet';
      else if (display.includes('chestplate')) clean = 'netherite_chestplate';
      else if (display.includes('leggings')) clean = 'netherite_leggings';
      else if (display.includes('boots')) clean = 'netherite_boots';
      else clean = 'netherite_ingot';
    } else if (clean.includes('amethyst') || display.includes('amethyst')) {
      isBlock = false;
      clean = 'amethyst_shard';
    } else if (clean.includes('cooked_mutton') || display.includes('mutton')) {
      isBlock = false;
      clean = 'cooked_mutton';
    } else if (clean.includes('lime') && (clean.includes('glass') || clean.includes('pane'))) {
      isBlock = true;
      clean = 'lime_stained_glass_pane';
    } else if (clean.includes('green') && (clean.includes('glass') || clean.includes('pane'))) {
      isBlock = true;
      clean = 'green_stained_glass_pane';
    } else if (clean.includes('black') && (clean.includes('glass') || clean.includes('pane'))) {
      isBlock = true;
      clean = 'black_stained_glass_pane';
    } else if (clean.includes('gray') && (clean.includes('glass') || clean.includes('pane'))) {
      isBlock = true;
      clean = 'gray_stained_glass_pane';
    } else if (clean.includes('bow')) {
      isBlock = false;
      clean = 'bow';
    } else if (clean.includes('arrow')) {
      isBlock = false;
      clean = 'arrow';
    } else if (clean.includes('chest') || display.includes('chest')) {
      if (display.includes('cyan') || clean.includes('cyan')) { isBlock = true; clean = 'cyan_shulker_box'; }
      else if (display.includes('red') || clean.includes('red')) { isBlock = true; clean = 'red_shulker_box'; }
      else { isBlock = true; clean = 'chest'; }
    } else if (clean.includes('key') || display.includes('key')) {
      isBlock = false;
      if (display.includes('trial') || clean.includes('trial')) clean = 'trial_key';
      else clean = 'tripwire_hook';
    } else if (clean.includes('generator') || display.includes('generator') || display.includes('gen')) {
      isBlock = true;
      clean = 'beacon';
    }

    // Glass panes have no standalone texture file; use the matching glass block texture instead
    clean = clean.replace(/(^|_)glass_pane$/, '$1glass');
    if (clean === 'sunflower') { isBlock = true; clean = 'sunflower_front'; }

    const folder = isBlock ? 'block' : 'item';
    return `https://raw.githubusercontent.com/InventivetalentDev/minecraft-assets/1.20.1/assets/minecraft/textures/${folder}/${clean}.png`;
  }

  function updateSpatialUI(pos, scoreboard, inventory, entities) {
    if (pos) {
      cardCoords.textContent = `X: ${pos.x}, Y: ${pos.y}, Z: ${pos.z}`;
      povXyz.textContent = `X: ${pos.x} | Y: ${pos.y} | Z: ${pos.z}`;
      povYawPitch.textContent = `${pos.yaw || 0}° / ${pos.pitch || 0}°`;
      povDimension.textContent = pos.dimension || 'Overworld';

      if (compassArrow) {
        compassArrow.style.transform = `rotate(${-pos.yaw || 0}deg)`;
      }

      if (playerMesh) {
        playerMesh.rotation.y = (pos.yaw || 0) * (Math.PI / 180);
      }
    }

    // Render Live Scoreboard HUD
    const title = (scoreboard && scoreboard.title) ? cleanLineText(scoreboard.title) : 'Gens Tycoon 4th';
    if (scoreboardTitle) scoreboardTitle.textContent = title;
    if (povSbTitle) povSbTitle.textContent = title;

    if (scoreboard && scoreboard.items && scoreboard.items.length > 0) {
      const filteredLines = [];
      scoreboard.items.forEach(item => {
        let text = cleanLineText(item.name);
        if (!text) return;
        if (/^\[(Citizen|Adventurer|Duke|King|Knight|Player|VIP|MVP)[^\]]*\]/i.test(text)) return;
        filteredLines.push({ name: text, value: item.value });
      });

      if (scoreboardLines && filteredLines.length > 0) {
        scoreboardLines.innerHTML = '';
        filteredLines.forEach(line => {
          const row = document.createElement('div');
          row.className = 'scoreboard-row';

          let displayName = line.name;
          let isHeader = displayName.endsWith(':') || (!displayName.includes(':') && !displayName.startsWith('|'));
          if (isHeader) {
            row.style.borderLeft = 'none';
            row.style.background = 'rgba(255, 255, 255, 0.05)';
            row.style.fontWeight = '700';
            row.style.color = '#f97316';
          }

          row.innerHTML = `
            <span class="scoreboard-label">${displayName}</span>
            ${line.value !== undefined && line.value !== null && line.value !== '' ? `<span class="scoreboard-val">${line.value}</span>` : ''}
          `;
          scoreboardLines.appendChild(row);
        });
      }

      if (povSbLines && filteredLines.length > 0) {
        povSbLines.innerHTML = '';
        filteredLines.forEach(line => {
          const div = document.createElement('div');
          let text = line.name;
          const isSectionHeader = text.endsWith(':') || (!text.includes(':') && !text.startsWith('|'));
          div.className = `pov-sb-line ${isSectionHeader ? 'section-header' : ''}`;

          if (isSectionHeader) {
            div.style.color = '#f97316';
            div.style.fontWeight = '700';
            div.style.marginTop = '0.3rem';
            div.textContent = text;
          } else {
            let formatted = text;
            if (!formatted.startsWith('|')) {
              formatted = '| ' + formatted;
            }
            formatted = formatted.replace(/^\|/, '<span class="bar">|</span>');
            formatted = formatted.replace(/:\s*([^\n]+)$/, ': <span class="val orange">$1</span>');

            div.innerHTML = formatted;
          }
          povSbLines.appendChild(div);
        });
      }
    } else {
      const state = botStates[activeBotId];
      const isOnline = state && state.status === 'online';
      const msg = isOnline ? 'Bot di game world. Klik tombol [/is] di bawah untuk memuat island scoreboard!' : 'Bot offline. Tekan Mulai Bot untuk menghubungkan.';

      if (scoreboardLines) {
        scoreboardLines.innerHTML = `<div class="scoreboard-row placeholder"><span>${msg}</span></div>`;
      }
      if (povSbLines) {
        povSbLines.innerHTML = `<div class="pov-sb-line" style="color: var(--text-muted); font-style: italic;">${msg}</div>`;
      }
    }

    // Render 3D Entities markers in Three.js
    if (entityGroup && window.THREE) {
      while (entityGroup.children.length > 0) {
        entityGroup.remove(entityGroup.children[0]);
      }

      if (Array.isArray(entities)) {
        entities.forEach(ent => {
          const entGeo = new THREE.SphereGeometry(0.3, 12, 12);
          const entMat = new THREE.MeshBasicMaterial({ color: ent.type === 'player' ? 0x4ade80 : 0xf87171 });
          const entMesh = new THREE.Mesh(entGeo, entMat);
          const angle = Math.random() * Math.PI * 2;
          const dist = Math.min(ent.distance || 5, 25);
          entMesh.position.set(Math.sin(angle) * dist, 0.5, Math.cos(angle) * dist);
          entityGroup.add(entMesh);
        });
      }
    }

    // Inventory Slots
    inventoryGridContainer.innerHTML = '';
    const itemMap = {};
    if (Array.isArray(inventory)) {
      inventory.forEach(item => {
        itemMap[item.slot] = item;
      });
    }

    for (let slotIdx = 0; slotIdx < 36; slotIdx++) {
      const slotDiv = document.createElement('div');
      const item = itemMap[slotIdx + 9] || itemMap[slotIdx];

      if (item) {
        slotDiv.className = 'inventory-slot has-item';
        const fullName = item.displayName || item.name;
        const abbr = fullName;
        const iconUrl = getItemTextureUrl(item.name, item.displayName);

        slotDiv.innerHTML = `
        <div class="item-icon-wrapper" title="${fullName}">
          <img src="${iconUrl}" alt="${abbr}" class="item-img" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';" />
          <span class="item-name-abbr fallback-abbr" style="display:none;">${abbr.substring(0, 8)}</span>
          ${item.count > 1 ? `<span class="item-count-badge">${item.count}</span>` : ''}
        </div>
      `;
      } else {
        slotDiv.className = 'inventory-slot';
      }
      inventoryGridContainer.appendChild(slotDiv);
    }

    // Render Entities Table (Players & Mobs Nearby with exact distance)
    if (entitiesTableBody) {
      entitiesTableBody.innerHTML = '';
      if (Array.isArray(entities) && entities.length > 0) {
        entities.forEach(ent => {
          const tr = document.createElement('tr');
          const isPlayer = ent.type === 'player';
          const badgeColor = isPlayer ? '#4ade80' : '#f87171';
          const typeLabel = isPlayer ? 'Pemain' : (ent.type || 'Entitas');

          let distLabel = `${ent.distance} m`;
          if (ent.distance === undefined || ent.distance === null) {
            distLabel = '0 m';
          }

          tr.innerHTML = `
            <td><code style="color: ${badgeColor}; font-weight: 700;">${typeLabel}</code></td>
            <td><strong>${ent.name}</strong></td>
            <td><span style="color: #38bdf8; font-family: 'JetBrains Mono', monospace; font-weight: 600;">${distLabel}</span></td>
          `;
          entitiesTableBody.appendChild(tr);
        });
      } else {
        entitiesTableBody.innerHTML = `
          <tr>
            <td colspan="3" style="text-align: center; color: var(--text-muted); padding: 1rem;">Mencari pemain dan entitas di sekitar bot...</td>
          </tr>
        `;
      }
    }
  }

  // ---- Minecraft-style tooltip (colors / bold / italic from server "runs") ----
  const mcTooltip = document.createElement('div');
  mcTooltip.id = 'mc-tooltip';
  mcTooltip.className = 'mc-tooltip hidden';
  document.body.appendChild(mcTooltip);

  // Clicking items whose lore says "click to buy" asks for confirmation first
  const BUY_LORE_PATTERN = /click to buy|klik untuk (?:beli|membeli)/i;
  const PRICE_LINE_PATTERN = /price|credit|harga|\$/i;

  function runsToPlain(runs) {
    return Array.isArray(runs) ? runs.map(r => (r && r.t) || '').join('') : '';
  }

  function appendRuns(container, runs) {
    runs.forEach(r => {
      if (!r || !r.t) return;
      const span = document.createElement('span');
      span.textContent = r.t;
      if (r.c) span.style.color = r.c;
      if (r.b) span.style.fontWeight = '700';
      if (r.i) span.style.fontStyle = 'italic';
      const deco = [];
      if (r.u) deco.push('underline');
      if (r.s) deco.push('line-through');
      if (deco.length) span.style.textDecoration = deco.join(' ');
      container.appendChild(span);
    });
  }

  function hideMcTooltip() {
    mcTooltip.classList.add('hidden');
  }

  function moveMcTooltip(evt) {
    const pad = 14;
    const rect = mcTooltip.getBoundingClientRect();
    let x = evt.clientX + pad;
    let y = evt.clientY - rect.height - 6;
    if (x + rect.width > window.innerWidth - 4) x = Math.max(4, evt.clientX - rect.width - pad);
    if (y < 4) y = Math.min(window.innerHeight - rect.height - 4, evt.clientY + 20);
    mcTooltip.style.left = `${x}px`;
    mcTooltip.style.top = `${y}px`;
  }

  function showMcTooltip(s, evt) {
    mcTooltip.innerHTML = '';

    const title = document.createElement('div');
    title.className = 'mc-line mc-title';
    if (Array.isArray(s.nameRuns) && s.nameRuns.length) {
      appendRuns(title, s.nameRuns);
    } else {
      title.textContent = s.customName || s.displayName || String(s.name || '').replace(/_/g, ' ');
    }
    mcTooltip.appendChild(title);

    if (Array.isArray(s.loreRuns)) {
      s.loreRuns.forEach(line => {
        const div = document.createElement('div');
        div.className = 'mc-line';
        if (Array.isArray(line) && line.length) appendRuns(div, line);
        mcTooltip.appendChild(div);
      });
    }

    mcTooltip.classList.remove('hidden');
    moveMcTooltip(evt);
  }

  function createGuiSlotElement(s) {
    const slotDiv = document.createElement('div');
    if (!s) return slotDiv;

    const rawName = String(s.name || '').toLowerCase().replace(/^minecraft:/, '');
    const isAir = !rawName || rawName === 'air';
    const vanillaName = String(s.displayName || '').trim();
    // Real item name & lore as defined by the server (sent by server.js)
    const customName = String(s.customName || '').trim();
    const lorePlain = Array.isArray(s.loreRuns) ? s.loreRuns.map(runsToPlain) : [];
    const rawDisp = (customName + ' ' + vanillaName).toLowerCase();

    const isGreenGlass = rawName.includes('lime') || rawName.includes('green') || rawName.includes('emerald') || rawDisp.includes('fix') || rawDisp.includes('repair') || rawDisp.includes('perbaiki') || rawDisp.includes('klik') || rawDisp.includes('click') || rawDisp.includes('hijau') || rawDisp.includes('green') || rawDisp.includes('lime');
    const isCover = rawName.includes('black') || rawName.includes('gray') || rawName.includes('purple') || rawDisp.includes('gacha') || rawDisp.includes('tutup') || rawDisp.includes('cover') || rawDisp.includes('locked');

    let slotClass = 'gui-slot';
    if (isGreenGlass) slotClass += ' green-glass';
    if (isCover) slotClass += ' cover-glass';
    slotDiv.className = slotClass;

    // Icon sources, in order: local inventory-style icon -> remote flat texture -> text label
    const iconUrls = [];
    if (!isAir) {
      iconUrls.push(`/icons/${encodeURIComponent(rawName)}.png`);
      const remote = getItemTextureUrl(s.name, s.displayName);
      if (remote) iconUrls.push(remote);
    }

    // Visible fallback text (shown when no icon could be loaded)
    let safeAbbr = '';
    if (!isAir) {
      if (customName) {
        safeAbbr = customName.substring(0, 10);
      } else if (vanillaName) {
        safeAbbr = vanillaName.substring(0, 10);
      } else {
        safeAbbr = rawName.replace(/_/g, ' ').substring(0, 10);
      }
    }

    // Build with DOM APIs (no innerHTML) so server-controlled names cannot inject HTML
    if (iconUrls.length) {
      const wrap = document.createElement('div');
      wrap.className = 'item-icon-wrapper';

      const fallback = document.createElement('span');
      fallback.className = 'slot-label fallback-abbr';
      fallback.style.display = 'none';
      fallback.textContent = safeAbbr;

      const img = document.createElement('img');
      img.className = 'item-img';
      img.alt = customName || vanillaName;
      let iconIdx = 0;
      img.addEventListener('error', () => {
        iconIdx++;
        if (iconIdx < iconUrls.length) {
          img.src = iconUrls[iconIdx];
        } else {
          img.style.display = 'none';
          fallback.style.display = 'block';
        }
      });
      img.src = iconUrls[0];

      wrap.appendChild(img);
      wrap.appendChild(fallback);
      if (s.count > 1) {
        const badge = document.createElement('span');
        badge.className = 'item-count-badge';
        badge.textContent = String(s.count);
        wrap.appendChild(badge);
      }
      slotDiv.appendChild(wrap);
    } else {
      const span = document.createElement('span');
      span.className = 'slot-label';
      span.textContent = safeAbbr;
      slotDiv.appendChild(span);
    }

    if (!isAir) {
      slotDiv.addEventListener('mouseenter', (evt) => showMcTooltip(s, evt));
      slotDiv.addEventListener('mousemove', moveMcTooltip);
      slotDiv.addEventListener('mouseleave', hideMcTooltip);
    }

    slotDiv.addEventListener('click', () => {
      hideMcTooltip();
      if (!isAir && BUY_LORE_PATTERN.test(lorePlain.join('\n'))) {
        const itemLabel = customName || vanillaName || rawName;
        const priceLines = lorePlain.filter(l => PRICE_LINE_PATTERN.test(l)).slice(0, 4);
        const msg = `Beli "${itemLabel}"?` + (priceLines.length ? `\n\n${priceLines.join('\n')}` : '');
        if (!confirm(msg)) return;
      }
      socket.emit('click-gui-slot', { botId: activeBotId, slot: s.slot });
    });

    return slotDiv;
  }

  // Render Interactive Minecraft Chest GUI Container Modal
  function renderGuiModal(gui) {
    if (!gui) return;
    currentActiveGui = gui;

    if (povGuiIndicator) {
      povGuiIndicator.classList.remove('hidden');
      if (povGuiTitle) povGuiTitle.textContent = gui.title || 'Chest GUI';
    }

    if (guiModalTitle) guiModalTitle.textContent = gui.title || 'Chest GUI';
    if (guiModal && !userClosedGui) guiModal.classList.remove('hidden');

    const chestGridContainer = document.getElementById('chest-grid-container');
    const inventoryGuiGrid = document.getElementById('inventory-gui-grid');
    const invDivider = document.querySelector('.gui-inventory-divider');

    // Rebuild the slots only when the GUI content changed (keeps tooltips and clicks stable)
    const guiSig = JSON.stringify(gui);
    if (guiSig === lastRenderedGuiSig && chestGridContainer && chestGridContainer.childElementCount > 0) return;
    lastRenderedGuiSig = guiSig;
    hideMcTooltip();

    if (chestGridContainer) {
      chestGridContainer.innerHTML = '';
      if (inventoryGuiGrid) inventoryGuiGrid.innerHTML = '';

      const invStart = (typeof gui.inventoryStart === 'number' && gui.inventoryStart > 0) ? gui.inventoryStart : 54;
      const allSlots = Array.isArray(gui.slots) ? gui.slots : [];

      const containerSlots = [];
      for (let i = 0; i < invStart; i++) {
        containerSlots.push(allSlots[i] || { slot: i, name: 'air', displayName: '', count: 0 });
      }

      const playerSlots = [];
      for (let i = 0; i < 36; i++) {
        const slotIdx = invStart + i;
        playerSlots.push(allSlots[slotIdx] || { slot: slotIdx, name: 'air', displayName: '', count: 0 });
      }

      if (invDivider) {
        invDivider.style.display = 'flex';
      }

      containerSlots.forEach((s) => {
        try {
          const slotDiv = createGuiSlotElement(s);
          chestGridContainer.appendChild(slotDiv);
        } catch (err) {
          console.error('Error rendering container slot:', err, s);
        }
      });

      if (inventoryGuiGrid) {
        playerSlots.forEach((s) => {
          try {
            const slotDiv = createGuiSlotElement(s);
            inventoryGuiGrid.appendChild(slotDiv);
          } catch (err) {
            console.error('Error rendering player slot:', err, s);
          }
        });
      }
    }
  }

  function closeGuiModalUI() {
    currentActiveGui = null;
    lastRenderedGuiSig = '';
    hideMcTooltip();
    if (povGuiIndicator) povGuiIndicator.classList.add('hidden');
    if (guiModal) guiModal.classList.add('hidden');
  }

  function populateSettings(cfg) {
    if (!cfg) return;
    document.getElementById('cfg-username').value = cfg.username || '';
    document.getElementById('cfg-host').value = cfg.host || '';
    document.getElementById('cfg-port').value = cfg.port || 25565;
    document.getElementById('cfg-version').value = cfg.version || 'auto';
    document.getElementById('cfg-auth').value = cfg.auth || 'offline';
    if (document.getElementById('cfg-password')) {
      document.getElementById('cfg-password').value = cfg.password || '';
    }
    document.getElementById('cfg-reconnect').checked = !!cfg.autoReconnect;

    document.getElementById('cfg-script-enabled').checked = !!cfg.scriptEnabled;

    let cmds = Array.isArray(cfg.autoCmds) ? [...cfg.autoCmds] : [];
    if (cmds.length === 0 && cfg.scriptText) {
      const lines = cfg.scriptText.split('\n').map(l => l.trim());
      let pendingDelay = 2;
      lines.forEach(l => {
        if (l.toLowerCase().startsWith('wait ')) {
          const val = parseInt(l.split(' ')[1] || '40');
          pendingDelay = Math.max(1, Math.round(val / 20));
        } else if (l.toLowerCase().startsWith('send ')) {
          cmds.push({ cmd: l.substring(5).trim(), delaySec: pendingDelay });
          pendingDelay = 2;
        }
      });
    }
    renderAutoCmdRows(cmds);
  }

  function appendLogEntry(log) {
    if (!log) return;
    const div = document.createElement('div');
    div.className = `log-entry ${log.type || 'info'}`;

    const spanTime = document.createElement('span');
    spanTime.className = 'timestamp';
    spanTime.textContent = `[${log.timestamp || ''}]`;

    const spanMsg = document.createElement('span');
    spanMsg.className = 'log-msg';
    spanMsg.textContent = log.message || '';

    div.appendChild(spanTime);
    div.appendChild(spanMsg);
    terminalBody.appendChild(div);

    if (chkAutoscroll.checked) {
      terminalBody.scrollTop = terminalBody.scrollHeight;
    }

    // Also update 3D POV Live Chat HUD Overlay!
    appendPovChatOverlay(log);
  }

  function sanitizeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function appendPovChatOverlay(log) {
    const povChatLines = document.getElementById('pov-chat-lines');
    if (!povChatLines || !log || !log.message) return;

    const div = document.createElement('div');
    div.className = `pov-chat-line ${log.type || 'server'}`;

    let text = sanitizeHtml(log.message || '');
    text = text
      .replace(/AlviNation/gi, '<span style="color:#ffaa00;font-weight:bold;">AlviNation</span>')
      .replace(/Entities/gi, '<span style="color:#ff5555;font-weight:bold;">Entities</span>')
      .replace(/Successfully/gi, '<span style="color:#55ff55;">Successfully</span>')
      .replace(/LEVEL UP/gi, '<span style="color:#ffaa00;font-weight:bold;">LEVEL UP</span>')
      .replace(/Your current Level/gi, '<span style="color:#55ff55;">Your current Level</span>');

    div.innerHTML = text;
    povChatLines.appendChild(div);

    while (povChatLines.children.length > 11) {
      povChatLines.removeChild(povChatLines.firstChild);
    }
  }

  function renderPovChatOverlay(logs) {
    const povChatLines = document.getElementById('pov-chat-lines');
    if (!povChatLines) return;
    povChatLines.innerHTML = '';
    if (Array.isArray(logs)) {
      logs.slice(-11).forEach(appendPovChatOverlay);
    }
  }
});
