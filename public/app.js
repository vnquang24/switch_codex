const statusCard = document.querySelector("#statusCard");
const profilesList = document.querySelector("#profilesList");
const importForm = document.querySelector("#importForm");
const importMirrorPreview = document.querySelector("#importMirrorPreview");
const deviceAuthForm = document.querySelector("#deviceAuthForm");
const deviceAuthCard = document.querySelector("#deviceAuthCard");
const deviceAuthStartButton = document.querySelector("#deviceAuthStartButton");
const deviceAuthCancelButton = document.querySelector("#deviceAuthCancelButton");
const refreshButton = document.querySelector("#refreshButton");
const toast = document.querySelector("#toast");
const rotationForm = document.querySelector("#rotationForm");
const rotationSuggestion = document.querySelector("#rotationSuggestion");
const rotationMonitorCard = document.querySelector("#rotationMonitorCard");
const rotationDialog = document.querySelector("#rotationDialog");
const rotationDialogBody = document.querySelector("#rotationDialogBody");
const rotationCloseButton = document.querySelector("#rotationCloseButton");
const rotationLaterButton = document.querySelector("#rotationLaterButton");
const rotationConfirmButton = document.querySelector("#rotationConfirmButton");
const notificationButton = document.querySelector("#notificationButton");
const notificationStatus = document.querySelector("#notificationStatus");
const tabButtons = Array.from(document.querySelectorAll("[data-tab]"));
const viewDashboard = document.querySelector("#viewDashboard");
const viewVault = document.querySelector("#viewVault");
const gptAccountForm = document.querySelector("#gptAccountForm");
const gptAccountsList = document.querySelector("#gptAccountsList");
const gptAccountMode = document.querySelector("#gptAccountMode");
const gptAccountResetButton = document.querySelector("#gptAccountReset");
const locale = navigator.language || "en-US";
const dateTimeFormatter = new Intl.DateTimeFormat(locale, {
  dateStyle: "medium",
  timeStyle: "short",
});

const DEFAULT_ROTATION_SETTINGS = {
  enabled: true,
  sessionThreshold: 25,
  weeklyThreshold: 20,
  cooldownMinutes: 30,
  desktopNotifications: true,
};
const ROTATION_SNOOZE_KEY = "switch-acc-codex.rotation-snooze";
const AUTO_REFRESH_MS = 60_000;

let activeAccountId = null;
let currentStatus = null;
let currentProfiles = [];
let rotationSuggestionState = null;
let isSwitching = false;
let autoRefreshTimer = null;
let deviceAuthPollTimer = null;
let lastNotifiedSignature = "";
let activeDesktopNotification = null;
let rotationSettingsState = { ...DEFAULT_ROTATION_SETTINGS };
let currentGptAccounts = [];
let activeIdentityKey = null;
let currentDeviceAuth = null;
let lastDeviceAuthCompletion = "";

profilesList.addEventListener("click", handleProfilesClick);
importForm.addEventListener("submit", handleImportSubmit);
deviceAuthForm.addEventListener("submit", handleDeviceAuthSubmit);
deviceAuthCancelButton.addEventListener("click", cancelDeviceAuthFlow);
rotationForm.addEventListener("input", handleRotationSettingsInput);
rotationCloseButton.addEventListener("click", closeRotationDialog);
rotationLaterButton.addEventListener("click", remindRotationLater);
rotationConfirmButton.addEventListener("click", confirmRotationSwitch);
notificationButton.addEventListener("click", requestDesktopNotificationPermission);
gptAccountForm.addEventListener("submit", handleGptAccountSubmit);
gptAccountResetButton.addEventListener("click", resetGptAccountForm);
gptAccountsList.addEventListener("click", handleGptAccountsClick);
tabButtons.forEach((button) => {
  button.addEventListener("click", () => setActiveTab(button.dataset.tab));
});
refreshButton.addEventListener("click", async () => {
  try {
    setButtonBusy(refreshButton, true, "Refreshing...");
    await refreshAll({ reason: "manual" });
    showToast("Reloaded local Codex state.");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setButtonBusy(refreshButton, false);
  }
});

async function boot() {
  rotationSettingsState = await fetchRotationSettings();
  applyRotationSettingsToForm(rotationSettingsState);
  updateNotificationControls();
  setActiveTab("dashboard");
  await refreshAll({ reason: "boot" });
  autoRefreshTimer = window.setInterval(() => {
    refreshAll({ reason: "poll" }).catch((error) => {
      showToast(error.message, true);
    });
  }, AUTO_REFRESH_MS);
  document.addEventListener("visibilitychange", handleVisibilityChange);
}

async function refreshAll({ reason = "manual" } = {}) {
  const [statusData, profilesData, gptAccountsData] = await Promise.all([
    request("/api/status"),
    request("/api/profiles"),
    request("/api/gpt-accounts"),
  ]);

  currentStatus = statusData;
  currentProfiles = profilesData.profiles || [];
  currentGptAccounts = gptAccountsData.accounts || [];
  activeAccountId = statusData.active?.accountId || null;
  activeIdentityKey = getIdentityKey(statusData.active);
  currentDeviceAuth = statusData.deviceAuth || null;

  renderStatus(statusData);
  renderProfiles(currentProfiles);
  renderGptAccounts(currentGptAccounts);
  renderDeviceAuth(currentDeviceAuth);
  updateImportMirrorPreview(statusData.active);
  renderRotationMonitor(statusData.rotationMonitor);
  updateRotationSuggestion(reason);
  syncDeviceAuthPolling();
  maybeHandleDeviceAuthCompletion(reason);
}

function setActiveTab(tab) {
  const isDashboard = tab !== "vault";
  viewDashboard.classList.toggle("view-section-hidden", !isDashboard);
  viewVault.classList.toggle("view-section-hidden", isDashboard);
  tabButtons.forEach((button) => {
    button.classList.toggle("tab-button-active", button.dataset.tab === tab);
  });
}

function renderStatus(data) {
  const active = data.active;

  if (!active) {
    statusCard.innerHTML = `
      <div class="metric-card metric-card-wide">
        <strong>No active auth</strong>
        <p>No <code>auth.json</code> was found in <code>${escapeHtml(data.codexHome)}</code>.</p>
      </div>
    `;
    return;
  }

  const tokenStatus = getTokenStatus(active);
  const subscriptionStatus = getSubscriptionStatus(active);
  const usageCards = renderUsageMetricCards(data.usage);

  statusCard.innerHTML = [
    renderMetricCard("Email", active.email || "Unknown"),
    renderMetricCard("Plan", active.plan || active.authMode || "Unknown"),
    renderMetricCard("Account ID", active.accountId || "Unknown", {
      compact: true,
    }),
    renderMetricCard("JWT status", tokenStatus.label, {
      tone: tokenStatus.tone,
    }),
    renderMetricCard(
      "JWT expires",
      formatDateTime(active.accessTokenExpiresAt) || "Unknown",
      { compact: true },
    ),
    renderMetricCard("Subscription", subscriptionStatus.label, {
      tone: subscriptionStatus.tone,
    }),
    renderMetricCard(
      "Subscription ends",
      formatDateTime(active.subscriptionActiveUntil) || "Unknown",
    ),
    ...usageCards,
    renderMetricCard("Codex home", data.codexHome, {
      compact: true,
    }),
  ].join("");
}

function renderProfiles(profiles) {
  if (profiles.length === 0) {
    profilesList.innerHTML = `
      <div class="empty-state">
        <strong>No saved profiles yet</strong>
        <p>Log into an account once, then use “Import current auth”.</p>
      </div>
    `;
    return;
  }

  profilesList.innerHTML = profiles
    .map((profile) => {
      const summary = profile.summary || {};
      const isActive =
        getIdentityKey(summary) &&
        activeIdentityKey &&
        getIdentityKey(summary) === activeIdentityKey;
      const tokenStatus = getTokenStatus(summary);
      const subscriptionStatus = getSubscriptionStatus(summary);
      const signals = [
        renderSignal("JWT", tokenStatus),
        renderSignal("Subscription", subscriptionStatus),
        ...renderUsageSignals(profile.usage),
      ].join("");
      const usageUpdatedAt = formatDateTime(profile.usage?.updatedAt);
      const usageSource = formatUsageSource(profile.usage?.source);

      return `
        <article class="profile-card ${isActive ? "profile-card-active" : ""}">
          <div class="profile-main">
            <div class="profile-copy">
              <p class="profile-name">${escapeHtml(profile.name)}</p>
              <p class="profile-meta">
                ${escapeHtml(summary.email || "Unknown email")} ·
                ${escapeHtml(summary.plan || summary.authMode || "Unknown mode")}
              </p>
              <p class="profile-id">${escapeHtml(summary.accountId || "No account id")}</p>
              <div class="profile-signals">${signals}</div>
              ${
                usageUpdatedAt
                  ? `<p class="profile-stamp">Usage snapshot ${escapeHtml(usageUpdatedAt)}${usageSource ? ` via ${escapeHtml(usageSource)}` : ""}</p>`
                  : ""
              }
            </div>
            ${isActive ? '<span class="badge">Active</span>' : ""}
          </div>
          <div class="profile-actions">
            <button data-switch="${escapeHtml(profile.id)}" type="button">Switch</button>
            <button data-delete="${escapeHtml(profile.id)}" class="danger" type="button">Delete</button>
          </div>
        </article>
      `;
    })
    .join("");
}

function updateRotationSuggestion(reason) {
  rotationSuggestionState = evaluateRotationSuggestion(currentStatus, currentProfiles);
  renderRotationSuggestion(rotationSuggestionState);
  maybePromptRotationSuggestion(rotationSuggestionState, reason);
}

function renderRotationSuggestion(suggestion) {
  if (!suggestion) {
    rotationSuggestion.innerHTML = `
      <strong>No suggestion right now</strong>
      <p>The app will watch session and weekly usage, then propose the next account automatically.</p>
    `;
    rotationSuggestion.className = "rotation-suggestion empty-state";
    return;
  }

  rotationSuggestion.className = "rotation-suggestion empty-state rotation-suggestion-live";
  rotationSuggestion.innerHTML = `
    <strong>${escapeHtml(suggestion.title)}</strong>
    <p class="rotation-copy">${escapeHtml(suggestion.message)}</p>
    <div class="rotation-stats">
      ${renderSignal("Current", {
        tone: suggestion.triggerTone,
        label: suggestion.currentLabel,
      })}
      ${renderSignal("Suggested", {
        tone: getPercentTone(suggestion.target.usage.primary?.remainingPercent),
        label: suggestion.targetLabel,
      })}
      ${suggestion.target.usage.secondary ? renderSignal("Weekly", {
        tone: getPercentTone(suggestion.target.usage.secondary.remainingPercent),
        label: formatUsageValue(suggestion.target.usage.secondary),
      }) : ""}
    </div>
    <div class="rotation-actions">
      <button id="rotationReviewButton" type="button">Review suggestion</button>
      <button id="rotationSnoozeButton" class="ghost-button" type="button">Remind later</button>
    </div>
  `;

  rotationSuggestion
    .querySelector("#rotationReviewButton")
    ?.addEventListener("click", () => openRotationDialog(suggestion));
  rotationSuggestion
    .querySelector("#rotationSnoozeButton")
    ?.addEventListener("click", remindRotationLater);
}

function renderRotationMonitor(state) {
  if (!state) {
    rotationMonitorCard.innerHTML = renderMetricCard(
      "Backend monitor",
      "No monitor state yet",
      { tone: "muted", wide: true },
    );
    return;
  }

  rotationMonitorCard.innerHTML = [
    renderMetricCard("Monitor", state.running ? "Checking now" : "Idle", {
      tone: state.running ? "warn" : "ok",
    }),
    renderMetricCard("Last check", formatDateTime(state.lastCheckedAt) || "Unknown"),
    renderMetricCard(
      "Last suggestion",
      state.lastSuggestionTitle || "No recent suggestion",
      { compact: true },
    ),
    renderMetricCard(
      "Last notification",
      state.lastNotificationOutcome || "No notification sent yet",
      { compact: true, wide: true, tone: monitorOutcomeTone(state.lastNotificationOutcome) },
    ),
  ].join("");
}

function maybePromptRotationSuggestion(suggestion, reason) {
  if (!suggestion || reason === "switch") {
    clearDesktopNotification();
    closeRotationDialog();
    return;
  }

  if (isSwitching) {
    return;
  }

  const snooze = loadRotationSnooze();
  if (
    snooze.signature === suggestion.signature &&
    Date.now() < snooze.until
  ) {
    return;
  }

  if (rotationDialog.open && rotationDialog.dataset.signature === suggestion.signature) {
    return;
  }

  maybeSendDesktopNotification(suggestion);
  openRotationDialog(suggestion);
}

function openRotationDialog(suggestion) {
  rotationDialog.dataset.signature = suggestion.signature;
  rotationDialogBody.innerHTML = `
    <p><strong>${escapeHtml(suggestion.title)}</strong></p>
    <p class="rotation-dialog-copy">${escapeHtml(suggestion.message)}</p>
    <div class="rotation-dialog-stats">
      <div class="metric-card metric-card-${escapeHtml(suggestion.triggerTone)}">
        <span class="label">Current account</span>
        <strong>${escapeHtml(suggestion.current.name)}</strong>
        <p>${escapeHtml(suggestion.currentLabel)}</p>
      </div>
      <div class="metric-card metric-card-ok">
        <span class="label">Suggested account</span>
        <strong>${escapeHtml(suggestion.target.name)}</strong>
        <p>${escapeHtml(suggestion.targetLabel)}</p>
      </div>
    </div>
  `;

  if (!rotationDialog.open) {
    rotationDialog.showModal();
  }
}

function closeRotationDialog() {
  if (rotationDialog.open) {
    rotationDialog.close();
  }
  rotationDialog.dataset.signature = "";
}

function remindRotationLater() {
  const suggestion = rotationSuggestionState;
  if (suggestion) {
    const settings = rotationSettingsState;
    saveRotationSnooze({
      signature: suggestion.signature,
      until: Date.now() + settings.cooldownMinutes * 60 * 1000,
    });
  }
  closeRotationDialog();
  clearDesktopNotification();
  showToast("Rotation reminder snoozed.");
}

async function confirmRotationSwitch() {
  const suggestion = rotationSuggestionState;
  if (!suggestion || isSwitching) {
    return;
  }

  rotationConfirmButton.disabled = true;
  rotationLaterButton.disabled = true;
  rotationCloseButton.disabled = true;
  isSwitching = true;

  try {
    await switchProfileById(suggestion.target.id);
    saveRotationSnooze({ signature: "", until: 0 });
    closeRotationDialog();
    clearDesktopNotification();
  } finally {
    isSwitching = false;
    rotationConfirmButton.disabled = false;
    rotationLaterButton.disabled = false;
    rotationCloseButton.disabled = false;
  }
}

function evaluateRotationSuggestion(statusData, profiles) {
  const settings = rotationSettingsState;
  if (!settings.enabled) {
    return null;
  }

  const active = statusData?.active;
  const activeUsage = statusData?.usage;
  const activeIdentity = getIdentityKey(active);
  if (!active || !activeIdentity || !activeUsage?.primary) {
    return null;
  }

  const sessionRemaining = activeUsage.primary.remainingPercent;
  const weeklyRemaining = activeUsage.secondary?.remainingPercent;
  const sessionTriggered = Number.isFinite(sessionRemaining)
    && sessionRemaining <= settings.sessionThreshold;
  const weeklyTriggered = Number.isFinite(weeklyRemaining)
    && weeklyRemaining <= settings.weeklyThreshold;

  if (!sessionTriggered && !weeklyTriggered) {
    return null;
  }

  const candidates = profiles
    .filter((profile) => profile.id && getIdentityKey(profile.summary) !== activeIdentity)
    .map((profile) => ({
      ...profile,
      score: scoreProfile(profile, settings),
    }))
    .filter((profile) => profile.score > 0)
    .sort((a, b) => b.score - a.score);

  const target = candidates[0];
  if (!target || !target.usage?.primary) {
    return null;
  }

  const reason = sessionTriggered ? "session" : "weekly";
  const currentName = resolveAccountName(active, profiles);
  const currentLabel = sessionTriggered
    ? `${formatPercent(sessionRemaining)} left in current 5h window`
    : `${formatPercent(weeklyRemaining)} left in current weekly window`;
  const targetLabel = `${formatUsageValue(target.usage.primary)} session`;
  const title = sessionTriggered
    ? `${currentName} is running low`
    : `${currentName} is near weekly exhaustion`;
  const message = sessionTriggered
    ? `${currentName} only has ${formatPercent(sessionRemaining)} session left. Switch to ${target.name}?`
    : `${currentName} only has ${formatPercent(weeklyRemaining)} weekly left. Switch to ${target.name}?`;

  return {
    signature: `${active.accountId}:${target.id}:${reason}:${Math.round(sessionRemaining || 0)}:${Math.round(weeklyRemaining || 0)}`,
    title,
    message,
    reason,
    triggerTone: sessionTriggered ? getPercentTone(sessionRemaining) : getPercentTone(weeklyRemaining),
    current: {
      name: currentName,
      accountId: active.accountId,
    },
    target,
    currentLabel,
    targetLabel,
  };
}

function scoreProfile(profile, settings) {
  const session = profile.usage?.primary?.remainingPercent;
  const weekly = profile.usage?.secondary?.remainingPercent;
  const updatedAt = Date.parse(profile.usage?.updatedAt || "");
  const freshnessPenaltyMinutes = Number.isFinite(updatedAt)
    ? (Date.now() - updatedAt) / 60000
    : 1_000;

  if (!Number.isFinite(session) || session <= settings.sessionThreshold) {
    return -1;
  }

  if (Number.isFinite(weekly) && weekly <= settings.weeklyThreshold) {
    return -1;
  }

  const sessionScore = session * 4;
  const weeklyScore = Number.isFinite(weekly) ? weekly * 1.5 : 25;
  const freshnessScore = Math.max(0, 40 - freshnessPenaltyMinutes);
  const sourceScore = profile.usage?.source === "oauth" ? 20 : 0;
  const creditScore = Number.isFinite(profile.usage?.credits?.remaining) ? 5 : 0;

  return sessionScore + weeklyScore + freshnessScore + sourceScore + creditScore;
}

function resolveAccountName(active, profiles) {
  const matchedProfile = profiles.find(
    (profile) => getIdentityKey(profile.summary) === getIdentityKey(active),
  );
  return matchedProfile?.name || active.email || active.accountId || "Current account";
}

function getIdentityKey(summary) {
  if (!summary || typeof summary !== "object") {
    return "";
  }
  return summary.userId || summary.email || summary.accountId || "";
}

async function fetchRotationSettings() {
  try {
    const data = await request("/api/rotation-settings");
    return normalizeRotationSettings(data.settings);
  } catch {
    return { ...DEFAULT_ROTATION_SETTINGS };
  }
}

function applyRotationSettingsToForm(settings) {
  rotationForm.rotationEnabled.checked = settings.enabled;
  rotationForm.sessionThreshold.value = String(settings.sessionThreshold);
  rotationForm.weeklyThreshold.value = String(settings.weeklyThreshold);
  rotationForm.cooldownMinutes.value = String(settings.cooldownMinutes);
  rotationForm.desktopNotifications.checked = settings.desktopNotifications;
}

async function handleRotationSettingsInput() {
  const settings = {
    enabled: rotationForm.rotationEnabled.checked,
    sessionThreshold: clampNumber(
      rotationForm.sessionThreshold.value,
      1,
      99,
      DEFAULT_ROTATION_SETTINGS.sessionThreshold,
    ),
    weeklyThreshold: clampNumber(
      rotationForm.weeklyThreshold.value,
      1,
      99,
      DEFAULT_ROTATION_SETTINGS.weeklyThreshold,
    ),
    cooldownMinutes: clampNumber(
      rotationForm.cooldownMinutes.value,
      5,
      720,
      DEFAULT_ROTATION_SETTINGS.cooldownMinutes,
    ),
    desktopNotifications: rotationForm.desktopNotifications.checked,
  };
  rotationSettingsState = normalizeRotationSettings(settings);
  applyRotationSettingsToForm(rotationSettingsState);
  try {
    const data = await request("/api/rotation-settings", {
      method: "POST",
      body: JSON.stringify(rotationSettingsState),
    });
    rotationSettingsState = normalizeRotationSettings(data.settings);
    applyRotationSettingsToForm(rotationSettingsState);
  } catch (error) {
    showToast(error.message, true);
  }
  updateRotationSuggestion("settings");
}

function loadRotationSnooze() {
  try {
    const saved = JSON.parse(localStorage.getItem(ROTATION_SNOOZE_KEY) || "{}");
    return {
      signature: typeof saved.signature === "string" ? saved.signature : "",
      until: Number.isFinite(saved.until) ? saved.until : 0,
    };
  } catch {
    return { signature: "", until: 0 };
  }
}

function saveRotationSnooze(value) {
  localStorage.setItem(ROTATION_SNOOZE_KEY, JSON.stringify(value));
}

function normalizeRotationSettings(settings) {
  return {
    enabled:
      typeof settings?.enabled === "boolean"
        ? settings.enabled
        : DEFAULT_ROTATION_SETTINGS.enabled,
    sessionThreshold: clampNumber(
      settings?.sessionThreshold,
      1,
      99,
      DEFAULT_ROTATION_SETTINGS.sessionThreshold,
    ),
    weeklyThreshold: clampNumber(
      settings?.weeklyThreshold,
      1,
      99,
      DEFAULT_ROTATION_SETTINGS.weeklyThreshold,
    ),
    cooldownMinutes: clampNumber(
      settings?.cooldownMinutes,
      5,
      720,
      DEFAULT_ROTATION_SETTINGS.cooldownMinutes,
    ),
    desktopNotifications:
      typeof settings?.desktopNotifications === "boolean"
        ? settings.desktopNotifications
        : DEFAULT_ROTATION_SETTINGS.desktopNotifications,
  };
}

function updateNotificationControls() {
  const permission = getNotificationPermission();
  if (permission === "unsupported") {
    notificationStatus.textContent = "This browser does not support desktop notifications.";
    notificationButton.disabled = true;
    notificationButton.textContent = "Notifications unavailable";
    return;
  }

  if (permission === "granted") {
    notificationStatus.textContent =
      "Desktop notifications are enabled for switch suggestions while this browser is running.";
    notificationButton.disabled = true;
    notificationButton.textContent = "Notifications enabled";
    return;
  }

  if (permission === "denied") {
    notificationStatus.textContent =
      "Desktop notifications are blocked in this browser. Re-enable them from browser site settings.";
    notificationButton.disabled = true;
    notificationButton.textContent = "Notifications blocked";
    return;
  }

  notificationStatus.textContent =
    "Browser permission not requested yet. Enable it to get Linux desktop alerts for switch suggestions.";
  notificationButton.disabled = false;
  notificationButton.textContent = "Enable desktop notifications";
}

function getNotificationPermission() {
  if (!("Notification" in window)) {
    return "unsupported";
  }
  return Notification.permission;
}

async function requestDesktopNotificationPermission() {
  const permission = getNotificationPermission();
  if (permission === "unsupported") {
    showToast("This browser does not support desktop notifications.", true);
    updateNotificationControls();
    return;
  }

  const nextPermission = await Notification.requestPermission();
  updateNotificationControls();

  if (nextPermission === "granted") {
    showToast("Desktop notifications enabled.");
    return;
  }

  if (nextPermission === "denied") {
    showToast("Desktop notifications were blocked.", true);
    return;
  }

  showToast("Desktop notification permission was dismissed.");
}

function maybeSendDesktopNotification(suggestion) {
  const permission = getNotificationPermission();
  if (permission !== "granted") {
    return;
  }

  if (document.visibilityState === "visible" && document.hasFocus()) {
    return;
  }

  if (lastNotifiedSignature === suggestion.signature) {
    return;
  }

  clearDesktopNotification();
  const notification = new Notification(suggestion.title, {
    body: suggestion.message,
    tag: `rotation-${suggestion.signature}`,
    requireInteraction: true,
  });
  notification.onclick = async () => {
    window.focus();
    notification.close();
    if (isSwitching) {
      return;
    }
    await switchProfileById(suggestion.target.id);
  };
  notification.onclose = () => {
    if (activeDesktopNotification === notification) {
      activeDesktopNotification = null;
    }
  };
  activeDesktopNotification = notification;
  lastNotifiedSignature = suggestion.signature;
}

function clearDesktopNotification() {
  if (activeDesktopNotification) {
    activeDesktopNotification.close();
    activeDesktopNotification = null;
  }
}

function handleVisibilityChange() {
  if (document.visibilityState === "visible") {
    clearDesktopNotification();
  }
}

function monitorOutcomeTone(value) {
  if (!value) {
    return "muted";
  }
  if (value.includes("switched")) {
    return "ok";
  }
  if (value.includes("failed")) {
    return "danger";
  }
  if (value.includes("ignored") || value.includes("dismissed")) {
    return "muted";
  }
  return "warn";
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

async function handleProfilesClick(event) {
  const switchButton = event.target.closest("[data-switch]");
  const deleteButton = event.target.closest("[data-delete]");

  if (!switchButton && !deleteButton) {
    return;
  }

  if (switchButton) {
    await switchProfileById(switchButton.dataset.switch, switchButton);
    return;
  }

  await deleteProfile(deleteButton);
}

async function switchProfileById(id, button = null) {
  setButtonBusy(button, true, "Switching...");

  try {
    const result = await request("/api/switch", {
      method: "POST",
      body: JSON.stringify({ id }),
    });
    const probeNote = Array.isArray(result.notes)
      ? result.notes.find((note) => String(note || "").includes("codex login status"))
      : "";
    showToast(probeNote ? `${result.message} ${probeNote}` : result.message);
    await refreshAll({ reason: "switch" });
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setButtonBusy(button, false);
  }
}

async function deleteProfile(button) {
  const id = button.dataset.delete;
  if (!window.confirm("Delete this saved profile?")) {
    return;
  }

  setButtonBusy(button, true, "Deleting...");

  try {
    const result = await request("/api/profiles/delete", {
      method: "POST",
      body: JSON.stringify({ id }),
    });
    showToast(result.message);
    await refreshAll({ reason: "delete" });
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setButtonBusy(button, false);
  }
}

async function handleImportSubmit(event) {
  event.preventDefault();
  const formData = new FormData(importForm);
  const profileName = String(formData.get("profileName") || "").trim();
  const saveToVault = formData.get("saveToVault") === "on";
  const password = String(formData.get("password") || "");
  const note = String(formData.get("note") || "");
  const submitButton = importForm.querySelector('button[type="submit"]');

  if (!profileName) {
    showToast("Profile name is required.", true);
    return;
  }

  if (saveToVault && !password.trim()) {
    showToast("Enter the GPT password before saving to GPT Accounts.", true);
    return;
  }

  const confirmMessage = saveToVault
    ? `Save current account as "${profileName}" and also store its email/password in GPT Accounts?`
    : `Save current account as "${profileName}"?`;
  if (!window.confirm(confirmMessage)) {
    return;
  }

  try {
    setButtonBusy(submitButton, true, "Importing...");
    const result = await request("/api/import-current", {
      method: "POST",
      body: JSON.stringify({
        name: profileName,
        saveToVault,
        password,
        note,
      }),
    });
    importForm.reset();
    updateImportMirrorPreview(currentStatus?.active || null);
    showToast(result.message);
    await refreshAll({ reason: "import" });
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setButtonBusy(submitButton, false);
  }
}

function updateImportMirrorPreview(active) {
  if (!importMirrorPreview) {
    return;
  }

  const email = active?.email || "No active email detected";
  const plan = active?.plan || active?.authMode || "unknown plan";
  importMirrorPreview.innerHTML = `
    Mirror target: <strong>${escapeHtml(email)}</strong> · ${escapeHtml(plan)}
  `;
}

function renderDeviceAuth(state) {
  if (!deviceAuthCard) {
    return;
  }

  const isRunning = Boolean(state?.running);
  const status = state?.status || "idle";
  const canOpen = Boolean(state?.verificationUri);
  const canCopy = Boolean(state?.userCode);

  deviceAuthStartButton.disabled = isRunning;
  deviceAuthCancelButton.disabled = !isRunning;
  deviceAuthForm.elements.profileName.disabled = isRunning;

  if (!state || status === "idle") {
    deviceAuthCard.className = "device-auth-card empty-state";
    deviceAuthCard.innerHTML = `
      <strong>No device-auth flow running</strong>
      <p>Start from here to open the official Codex login page, then the app will save the resulting auth into a new profile automatically.</p>
    `;
    return;
  }

  const toneClass = status === "completed"
    ? "device-auth-card-ok"
    : status === "failed"
      ? "device-auth-card-danger"
      : "device-auth-card-live";

  deviceAuthCard.className = `device-auth-card ${toneClass}`;
  deviceAuthCard.innerHTML = `
    <p class="device-auth-label">Status</p>
    <strong>${escapeHtml(formatDeviceAuthStatus(status))}</strong>
    <p class="device-auth-copy">${escapeHtml(state.message || "Waiting for Codex login output...")}</p>
    ${
      state.userCode
        ? `<div class="device-auth-code-row">
            <code class="device-auth-code">${escapeHtml(state.userCode)}</code>
            <button id="deviceAuthCopyCodeButton" class="ghost-button" type="button">Copy code</button>
          </div>`
        : ""
    }
    ${
      state.verificationUri
        ? `<p class="device-auth-link-row">
            <a id="deviceAuthOpenLink" href="${escapeHtml(state.verificationUri)}" target="_blank" rel="noreferrer">Open device login page</a>
          </p>`
        : ""
    }
    <p class="profile-stamp">
      Profile target: ${escapeHtml(state.profileName || "Unknown")}
      ${state.expiresAt ? ` · Code expires ${escapeHtml(formatDateTime(state.expiresAt) || "soon")}` : ""}
      ${state.completedAt ? ` · Finished ${escapeHtml(formatDateTime(state.completedAt) || "just now")}` : ""}
    </p>
  `;

  if (canOpen) {
    deviceAuthCard
      .querySelector("#deviceAuthOpenLink")
      ?.addEventListener("click", () => {
        showToast("Opened Codex device login page in a new tab.");
      });
  }

  if (canCopy) {
    deviceAuthCard
      .querySelector("#deviceAuthCopyCodeButton")
      ?.addEventListener("click", copyDeviceAuthCode);
  }
}

function formatDeviceAuthStatus(status) {
  if (status === "starting") {
    return "Starting";
  }
  if (status === "awaiting_confirmation") {
    return "Waiting for browser confirmation";
  }
  if (status === "completed") {
    return "Completed";
  }
  if (status === "failed") {
    return "Failed";
  }
  if (status === "cancelled") {
    return "Cancelled";
  }
  return "Idle";
}

function syncDeviceAuthPolling() {
  const shouldPoll = Boolean(
    currentDeviceAuth && ["starting", "awaiting_confirmation"].includes(currentDeviceAuth.status),
  );

  if (shouldPoll && !deviceAuthPollTimer) {
    deviceAuthPollTimer = window.setInterval(() => {
      refreshAll({ reason: "device-auth-poll" }).catch((error) => {
        showToast(error.message, true);
      });
    }, 2000);
    return;
  }

  if (!shouldPoll && deviceAuthPollTimer) {
    window.clearInterval(deviceAuthPollTimer);
    deviceAuthPollTimer = null;
  }
}

function maybeHandleDeviceAuthCompletion(reason) {
  if (!currentDeviceAuth?.completedAt) {
    return;
  }

  if (currentDeviceAuth.completedAt === lastDeviceAuthCompletion) {
    return;
  }

  lastDeviceAuthCompletion = currentDeviceAuth.completedAt;

  if (reason === "device-auth-poll" || reason === "device-auth-start") {
    if (currentDeviceAuth.status === "completed") {
      showToast(currentDeviceAuth.message || "Logged in via device auth.");
      updateImportMirrorPreview(currentStatus?.active || null);
      deviceAuthForm.reset();
      return;
    }

    if (currentDeviceAuth.status === "failed") {
      showToast(currentDeviceAuth.error || "Device-auth failed.", true);
      return;
    }

    if (currentDeviceAuth.status === "cancelled") {
      showToast("Cancelled device-auth login.");
    }
  }
}

async function handleDeviceAuthSubmit(event) {
  event.preventDefault();
  const profileName = String(deviceAuthForm.elements.profileName.value || "").trim();

  if (!profileName) {
    showToast("Profile name is required for device login.", true);
    return;
  }

  try {
    setButtonBusy(deviceAuthStartButton, true, "Starting...");
    const result = await request("/api/device-auth/start", {
      method: "POST",
      body: JSON.stringify({ name: profileName }),
    });
    currentDeviceAuth = result;
    renderDeviceAuth(currentDeviceAuth);
    syncDeviceAuthPolling();
    showToast(`Started Codex device login for "${profileName}".`);
    await refreshAll({ reason: "device-auth-start" });
    if (currentDeviceAuth?.verificationUri) {
      window.open(currentDeviceAuth.verificationUri, "_blank", "noopener,noreferrer");
    }
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setButtonBusy(deviceAuthStartButton, false);
    renderDeviceAuth(currentDeviceAuth);
  }
}

async function cancelDeviceAuthFlow() {
  try {
    const result = await request("/api/device-auth/cancel", {
      method: "POST",
    });
    currentDeviceAuth = result.deviceAuth || currentDeviceAuth;
    renderDeviceAuth(currentDeviceAuth);
    syncDeviceAuthPolling();
    showToast(result.message);
  } catch (error) {
    showToast(error.message, true);
  }
}

async function copyDeviceAuthCode() {
  if (!currentDeviceAuth?.userCode) {
    return;
  }

  try {
    await navigator.clipboard.writeText(currentDeviceAuth.userCode);
    showToast("Copied device code.");
  } catch {
    showToast("Clipboard write failed in this browser.", true);
  }
}

function renderGptAccounts(accounts) {
  if (!accounts.length) {
    gptAccountsList.innerHTML = `
      <div class="empty-state">
        <strong>No GPT credentials saved yet</strong>
        <p>Add your GPT web accounts here so you do not need to hunt for passwords later.</p>
      </div>
    `;
    return;
  }

  gptAccountsList.innerHTML = accounts
    .map((account) => `
      <article class="profile-card">
        <div class="profile-main">
          <div class="profile-copy">
            <p class="profile-name">${escapeHtml(account.name)}</p>
            <p class="profile-meta">${escapeHtml(account.email || "No email saved")}</p>
            <p class="profile-stamp">Updated ${escapeHtml(formatDateTime(account.updatedAt) || "Unknown")}</p>
            ${
              account.note
                ? `<p class="profile-stamp">${escapeHtml(account.note)}</p>`
                : ""
            }
            <div class="secret-row">
              <div class="secret-field">
                <input id="secret-${escapeHtml(account.id)}" type="password" value="${escapeHtml(account.password || "")}" readonly>
                <button class="ghost-button" data-toggle-secret="${escapeHtml(account.id)}" type="button">Show password</button>
                <button class="ghost-button" data-copy-secret="${escapeHtml(account.id)}" type="button">Copy</button>
              </div>
            </div>
          </div>
          <span class="badge badge-muted">Local only</span>
        </div>
        <div class="profile-actions">
          <button data-edit-account="${escapeHtml(account.id)}" type="button">Edit</button>
          <button data-delete-account="${escapeHtml(account.id)}" class="danger" type="button">Delete</button>
        </div>
      </article>
    `)
    .join("");
}

function resetGptAccountForm() {
  gptAccountForm.reset();
  gptAccountForm.elements.id.value = "";
  gptAccountMode.textContent = "Create";
}

function populateGptAccountForm(account) {
  gptAccountForm.elements.id.value = account.id;
  gptAccountForm.elements.name.value = account.name || "";
  gptAccountForm.elements.email.value = account.email || "";
  gptAccountForm.elements.password.value = account.password || "";
  gptAccountForm.elements.note.value = account.note || "";
  gptAccountMode.textContent = "Edit";
  setActiveTab("vault");
}

async function handleGptAccountSubmit(event) {
  event.preventDefault();
  const formData = new FormData(gptAccountForm);
  const submitButton = gptAccountForm.querySelector('button[type="submit"]');

  try {
    setButtonBusy(submitButton, true, "Saving...");
    const result = await request("/api/gpt-accounts", {
      method: "POST",
      body: JSON.stringify({
        id: formData.get("id"),
        name: formData.get("name"),
        email: formData.get("email"),
        password: formData.get("password"),
        note: formData.get("note"),
      }),
    });
    resetGptAccountForm();
    showToast(result.message);
    await refreshAll({ reason: "gpt-account-save" });
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setButtonBusy(submitButton, false);
  }
}

async function handleGptAccountsClick(event) {
  const toggleButton = event.target.closest("[data-toggle-secret]");
  const copyButton = event.target.closest("[data-copy-secret]");
  const editButton = event.target.closest("[data-edit-account]");
  const deleteButton = event.target.closest("[data-delete-account]");

  if (toggleButton) {
    const input = document.querySelector(`#secret-${CSS.escape(toggleButton.dataset.toggleSecret)}`);
    if (!input) {
      return;
    }
    const isHidden = input.type === "password";
    input.type = isHidden ? "text" : "password";
    toggleButton.textContent = isHidden ? "Hide password" : "Show password";
    return;
  }

  if (copyButton) {
    const account = currentGptAccounts.find((item) => item.id === copyButton.dataset.copySecret);
    if (!account?.password) {
      showToast("No password saved for this account.", true);
      return;
    }
    try {
      await navigator.clipboard.writeText(account.password);
      showToast(`Copied password for ${account.name}.`);
    } catch {
      showToast("Clipboard write failed in this browser.", true);
    }
    return;
  }

  if (editButton) {
    const account = currentGptAccounts.find((item) => item.id === editButton.dataset.editAccount);
    if (account) {
      populateGptAccountForm(account);
    }
    return;
  }

  if (deleteButton) {
    const account = currentGptAccounts.find((item) => item.id === deleteButton.dataset.deleteAccount);
    if (!account) {
      return;
    }
    if (!window.confirm(`Delete GPT account "${account.name}"?`)) {
      return;
    }
    setButtonBusy(deleteButton, true, "Deleting...");
    try {
      const result = await request("/api/gpt-accounts/delete", {
        method: "POST",
        body: JSON.stringify({ id: account.id }),
      });
      if (gptAccountForm.elements.id.value === account.id) {
        resetGptAccountForm();
      }
      showToast(result.message);
      await refreshAll({ reason: "gpt-account-delete" });
    } catch (error) {
      showToast(error.message, true);
    } finally {
      setButtonBusy(deleteButton, false);
    }
  }
}

function renderMetricCard(label, value, options = {}) {
  const classes = ["metric-card"];
  if (options.tone) {
    classes.push(`metric-card-${options.tone}`);
  }
  if (options.wide) {
    classes.push("metric-card-wide");
  }

  return `
    <div class="${classes.join(" ")}">
      <span class="label">${escapeHtml(label)}</span>
      <strong class="${options.compact ? "compact" : ""}">${escapeHtml(value)}</strong>
    </div>
  `;
}

function renderSignal(label, status) {
  return `
    <span class="signal signal-${escapeHtml(status.tone)}">
      <strong>${escapeHtml(label)}</strong>
      ${escapeHtml(status.label)}
    </span>
  `;
}

function renderUsageMetricCards(usage) {
  if (!usage) {
    return [
      renderMetricCard("Live usage limit", "No live usage snapshot available", {
        tone: "muted",
      }),
    ];
  }

  const cards = [];
  if (usage.source) {
    cards.push(
      renderMetricCard("Usage source", formatUsageSource(usage.source), {
        tone: "muted",
      }),
    );
  }
  if (usage.primary) {
    cards.push(
      renderMetricCard("Session limit", formatUsageValue(usage.primary), {
        tone: getPercentTone(usage.primary.remainingPercent),
      }),
    );
  }

  if (usage.secondary) {
    cards.push(
      renderMetricCard("Weekly limit", formatUsageValue(usage.secondary), {
        tone: getPercentTone(usage.secondary.remainingPercent),
      }),
    );
  }

  if (usage.credits) {
    cards.push(
      renderMetricCard("Credits", formatCredits(usage.credits.remaining), {
        tone: "ok",
      }),
    );
  }

  if (cards.length === 0) {
    cards.push(
      renderMetricCard("Live usage limit", "No live usage snapshot available", {
        tone: "muted",
      }),
    );
  }

  return cards;
}

function renderUsageSignals(usage) {
  if (!usage) {
    return [];
  }

  const signals = [];
  if (usage.primary) {
    signals.push(
      renderSignal("Session", {
        tone: getPercentTone(usage.primary.remainingPercent),
        label: formatUsageValue(usage.primary),
      }),
    );
  }

  if (usage.secondary) {
    signals.push(
      renderSignal("Weekly", {
        tone: getPercentTone(usage.secondary.remainingPercent),
        label: formatUsageValue(usage.secondary),
      }),
    );
  }

  if (usage.credits) {
    signals.push(
      renderSignal("Credits", {
        tone: "ok",
        label: formatCredits(usage.credits.remaining),
      }),
    );
  }

  return signals;
}

function getTokenStatus(summary) {
  const remainingMs = summary.accessTokenRemainingMs;
  if (typeof remainingMs !== "number") {
    return {
      tone: "muted",
      label: "Unknown",
    };
  }

  if (remainingMs <= 0) {
    return {
      tone: "danger",
      label: `Expired ${formatCompactDuration(Math.abs(remainingMs))} ago`,
    };
  }

  return {
    tone: remainingMs <= 6 * 60 * 60 * 1000 ? "warn" : "ok",
    label: `${formatCompactDuration(remainingMs)} left`,
  };
}

function getSubscriptionStatus(summary) {
  const remainingMs = summary.subscriptionRemainingMs;
  if (typeof remainingMs !== "number") {
    return {
      tone: "muted",
      label: "Not exposed by local auth",
    };
  }

  if (remainingMs <= 0) {
    return {
      tone: "danger",
      label: `Expired ${formatCompactDuration(Math.abs(remainingMs))} ago`,
    };
  }

  return {
    tone: remainingMs <= 3 * 24 * 60 * 60 * 1000 ? "warn" : "ok",
    label: `${formatCompactDuration(remainingMs)} left`,
  };
}

function formatCompactDuration(ms) {
  if (!Number.isFinite(ms)) {
    return "Unknown";
  }

  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  if (minutes > 0) {
    return `${minutes}m`;
  }

  return "<1m";
}

function formatDateTime(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return dateTimeFormatter.format(date);
}

function formatPercent(value) {
  if (!Number.isFinite(value)) {
    return "Unknown";
  }

  return `${Math.round(value)}%`;
}

function formatCredits(value) {
  if (!Number.isFinite(value)) {
    return "Unknown";
  }

  return value >= 100 ? `$${value.toFixed(0)}` : `$${value.toFixed(1)}`;
}

function getPercentTone(value) {
  if (!Number.isFinite(value)) {
    return "muted";
  }

  if (value <= 10) {
    return "danger";
  }

  if (value <= 25) {
    return "warn";
  }

  return "ok";
}

function formatUsageValue(window) {
  const remaining = `${formatPercent(window.remainingPercent)} left`;
  const resetsAt = formatDateTime(window.resetsAt);
  return resetsAt ? `${remaining} · ${resetsAt}` : remaining;
}

function formatUsageSource(source) {
  if (!source) {
    return "";
  }

  if (source === "oauth") {
    return "OAuth API";
  }

  return source;
}

function setButtonBusy(button, isBusy, busyLabel) {
  if (!button) {
    return;
  }

  if (isBusy) {
    button.dataset.originalText = button.textContent;
    button.textContent = busyLabel;
    button.disabled = true;
    return;
  }

  button.textContent = button.dataset.originalText || button.textContent;
  button.disabled = false;
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
    },
    ...options,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }

  return data;
}

function showToast(message, isError = false) {
  toast.hidden = false;
  toast.textContent = message;
  toast.classList.toggle("toast-error", isError);
  clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    toast.hidden = true;
  }, 3000);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

boot().catch((error) => {
  showToast(error.message, true);
});
