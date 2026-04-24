const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3188);
const APP_ROOT = __dirname;
const PUBLIC_DIR = path.join(APP_ROOT, "public");
const STORAGE_DIR = path.join(APP_ROOT, "storage");
const PROFILES_DIR = path.join(STORAGE_DIR, "profiles");
const BACKUPS_DIR = path.join(STORAGE_DIR, "backups");
const SETTINGS_PATH = path.join(STORAGE_DIR, "rotation-settings.json");
const GPT_ACCOUNTS_PATH = path.join(STORAGE_DIR, "gpt-accounts.json");
const USAGE_CACHE_TTL_MS = 15_000;
const OAUTH_REFRESH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_CHATGPT_BASE_URL = "https://chatgpt.com/backend-api/";
const CHATGPT_USAGE_PATH = "/wham/usage";
const CODEX_USAGE_PATH = "/api/codex/usage";
const TOKEN_REFRESH_THRESHOLD_MS = 8 * 24 * 60 * 60 * 1000;
const ROTATION_MONITOR_INTERVAL_MS = 60_000;
const CODEX_HOME = resolveCodexHome();
const CODEX_BIN = resolveCodexBin();
const AUTH_PATH = path.join(CODEX_HOME, "auth.json");
const CONFIG_PATH = path.join(CODEX_HOME, "config.toml");
const STATE_DB_PATH = path.join(CODEX_HOME, "state_5.sqlite");

const usageCache = new Map();
const DEFAULT_ROTATION_SETTINGS = {
  enabled: true,
  sessionThreshold: 25,
  weeklyThreshold: 20,
  cooldownMinutes: 30,
  desktopNotifications: true,
};
const rotationMonitorState = {
  running: false,
  timer: null,
  lastSignature: "",
  lastNotifiedAt: 0,
  lastCheckedAt: 0,
  lastSuggestionTitle: "",
  lastNotificationOutcome: "",
};
const deviceAuthState = {
  process: null,
  running: false,
  status: "idle",
  profileName: "",
  startedAt: null,
  expiresAt: null,
  completedAt: null,
  verificationUri: null,
  userCode: null,
  message: "",
  error: "",
};

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function main() {
  await ensureDirectories();
  await startRotationMonitor();

  const server = http.createServer(async (req, res) => {
    try {
      if (req.url.startsWith("/api/")) {
        await handleApi(req, res);
        return;
      }

      await handleStatic(req, res);
    } catch (error) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : "Unknown server error",
      });
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`Switch Acc Codex running at http://${HOST}:${PORT}`);
    console.log(`Using Codex home: ${CODEX_HOME}`);
  });
}

function resolveCodexHome() {
  const override = process.env.CODEX_HOME;
  if (override && override.trim()) {
    return path.resolve(override);
  }

  return path.join(os.homedir(), ".codex");
}

function resolveCodexBin() {
  const explicit = String(process.env.CODEX_BIN || "").trim();
  const homeDir = process.env.HOME || os.homedir();
  const pathEntries = String(process.env.PATH || "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const candidates = [
    explicit,
    path.join(homeDir, ".nvm", "versions", "node", "v22.22.2", "bin", "codex"),
    path.join(homeDir, ".local", "bin", "codex"),
    ...pathEntries.map((entry) => path.join(entry, "codex")),
    "codex",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate === "codex") {
      return candidate;
    }

    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }

  return "codex";
}

async function ensureDirectories() {
  await fsp.mkdir(PUBLIC_DIR, { recursive: true });
  await fsp.mkdir(PROFILES_DIR, { recursive: true });
  await fsp.mkdir(BACKUPS_DIR, { recursive: true });
}

async function startRotationMonitor() {
  await checkAndNotifyRotationSuggestion();
  rotationMonitorState.timer = setInterval(() => {
    checkAndNotifyRotationSuggestion().catch((error) => {
      console.warn(`Rotation monitor failed: ${error.message}`);
    });
  }, ROTATION_MONITOR_INTERVAL_MS);
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);

  if (req.method === "GET" && url.pathname === "/api/status") {
    const status = await getStatus();
    sendJson(res, 200, status);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/device-auth/start") {
    const body = await readBody(req);
    const result = await startDeviceAuth(body);
    sendJson(res, 202, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/device-auth/cancel") {
    const result = cancelDeviceAuth();
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/profiles") {
    const profiles = await listProfiles();
    sendJson(res, 200, { profiles });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/gpt-accounts") {
    const accounts = await listGptAccounts();
    sendJson(res, 200, { accounts });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/rotation-settings") {
    const settings = await loadRotationSettings();
    sendJson(res, 200, { settings });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/rotation-settings") {
    const body = await readBody(req);
    const settings = await saveRotationSettings(body);
    sendJson(res, 200, { settings });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/gpt-accounts") {
    const body = await readBody(req);
    const account = await saveGptAccount(body);
    sendJson(res, 200, {
      message: body?.id
        ? `Updated GPT account "${account.name}"`
        : `Saved GPT account "${account.name}"`,
      account,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/import-current") {
    const body = await readBody(req);
    const profile = await importCurrentProfile({
      name: body.name,
      saveToVault: body.saveToVault,
      password: body.password,
      note: body.note,
    });
    sendJson(res, 201, {
      message: profile.savedToVault
        ? `Imported current account as "${profile.name}" and mirrored it to GPT Accounts`
        : `Imported current account as "${profile.name}"`,
      profile,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/switch") {
    const body = await readBody(req);
    const result = await switchProfile(body.id);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/profiles/delete") {
    const body = await readBody(req);
    const result = await deleteProfile(body.id);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/gpt-accounts/delete") {
    const body = await readBody(req);
    const result = await deleteGptAccount(body.id);
    sendJson(res, 200, result);
    return;
  }

  sendJson(res, 404, { error: "API route not found" });
}

async function handleStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const relativePath = path
    .normalize(pathname)
    .replace(/^[/\\]+/, "")
    .replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, relativePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) {
      sendText(res, 404, "Not found");
      return;
    }

    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    sendText(res, 404, "Not found");
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Invalid JSON body");
  }
}

async function getStatus() {
  const activeAuth = await readActiveAuth();
  const summary = activeAuth ? summarizeAuth(activeAuth) : null;
  const [profilesCount, usage] = await Promise.all([
    countProfiles(),
    activeAuth
      ? getLiveUsageSnapshot({
          auth: activeAuth,
          accountId: summary?.accountId || null,
          persistAuthPath: AUTH_PATH,
          allowCliFallback: true,
        })
      : Promise.resolve(null),
  ]);

  return {
    codexHome: CODEX_HOME,
    authPath: AUTH_PATH,
    stateDbPath: STATE_DB_PATH,
    active: summary,
    usage,
    profilesCount,
    rotationMonitor: getRotationMonitorSnapshot(),
    deviceAuth: getDeviceAuthSnapshot(),
  };
}

async function readActiveAuth() {
  try {
    const raw = await fsp.readFile(AUTH_PATH, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }

    throw new Error(`Failed to read ${AUTH_PATH}: ${error.message}`);
  }
}

function summarizeAuth(auth) {
  const now = Date.now();
  const tokens = auth?.tokens || {};
  const idClaims = decodeJwtPayload(tokens.id_token);
  const accessClaims = decodeJwtPayload(tokens.access_token);
  const openaiAuth =
    idClaims["https://api.openai.com/auth"] ||
    accessClaims["https://api.openai.com/auth"] ||
    {};
  const profileClaims = accessClaims["https://api.openai.com/profile"] || {};

  const accessTokenRemainingMs = getRemainingMs(accessClaims.exp, now);
  const subscriptionActiveUntil = normalizeTimestamp(
    openaiAuth.chatgpt_subscription_active_until,
  );
  const subscriptionRemainingMs = getRemainingMs(subscriptionActiveUntil, now);

  return {
    authMode: auth?.auth_mode || "unknown",
    email: idClaims.email || profileClaims.email || null,
    name: idClaims.name || null,
    plan: openaiAuth.chatgpt_plan_type || null,
    accountId: tokens.account_id || openaiAuth.chatgpt_account_id || null,
    userId: openaiAuth.user_id || openaiAuth.chatgpt_user_id || null,
    lastRefresh: auth?.last_refresh || null,
    hasApiKey: Boolean(auth?.OPENAI_API_KEY),
    hasRefreshToken: Boolean(tokens.refresh_token),
    accessTokenExpiresAt: toIsoFromUnixSeconds(accessClaims.exp),
    accessTokenRemainingMs,
    accessTokenState: classifyRemainingMs(accessTokenRemainingMs, 6 * 60 * 60 * 1000),
    idTokenExpiresAt: toIsoFromUnixSeconds(idClaims.exp),
    subscriptionActiveStart: normalizeTimestamp(
      openaiAuth.chatgpt_subscription_active_start,
    ),
    subscriptionActiveUntil,
    subscriptionLastChecked: normalizeTimestamp(
      openaiAuth.chatgpt_subscription_last_checked,
    ),
    subscriptionRemainingMs,
    subscriptionState: classifyRemainingMs(
      subscriptionRemainingMs,
      3 * 24 * 60 * 60 * 1000,
    ),
  };
}

function decodeJwtPayload(token) {
  if (!token || typeof token !== "string") {
    return {};
  }

  const parts = token.split(".");
  if (parts.length < 2) {
    return {};
  }

  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    return JSON.parse(json);
  } catch {
    return {};
  }
}

function toIsoFromUnixSeconds(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  return new Date(value * 1000).toISOString();
}

function normalizeTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return new Date(timestamp).toISOString();
}

function getRemainingMs(value, now) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value * 1000 - now;
  }

  if (typeof value === "string" && value.trim()) {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) {
      return timestamp - now;
    }
  }

  return null;
}

function classifyRemainingMs(value, warningThresholdMs) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "unknown";
  }

  if (value <= 0) {
    return "expired";
  }

  if (value <= warningThresholdMs) {
    return "warning";
  }

  return "healthy";
}

function makeEmptySummary() {
  return {
    authMode: "unknown",
    email: null,
    name: null,
    plan: null,
    accountId: null,
    userId: null,
    lastRefresh: null,
    hasApiKey: false,
    hasRefreshToken: false,
    accessTokenExpiresAt: null,
    accessTokenRemainingMs: null,
    accessTokenState: "unknown",
    idTokenExpiresAt: null,
    subscriptionActiveStart: null,
    subscriptionActiveUntil: null,
    subscriptionLastChecked: null,
    subscriptionRemainingMs: null,
    subscriptionState: "unknown",
  };
}

async function importCurrentProfile(input) {
  const trimmedName = typeof input?.name === "string" ? input.name.trim() : "";
  if (!trimmedName) {
    throw new Error("Profile name is required");
  }

  const auth = await readActiveAuth();
  if (!auth) {
    throw new Error("No active Codex auth.json found to import");
  }

  const summary = summarizeAuth(auth);
  const usage = await getLiveUsageSnapshot({
    auth,
    force: true,
    accountId: summary.accountId || null,
    persistAuthPath: AUTH_PATH,
    allowCliFallback: true,
  });
  const authToStore = (await readActiveAuth()) || auth;
  const storedSummary = summarizeAuth(authToStore);
  const id = createProfileId(trimmedName);
  const profileDir = path.join(PROFILES_DIR, id);

  await fsp.mkdir(profileDir, { recursive: true });
  await writeJsonAtomic(path.join(profileDir, "auth.json"), authToStore, 0o600);
  await writeJsonAtomic(
    path.join(profileDir, "meta.json"),
    {
      id,
      name: trimmedName,
      createdAt: new Date().toISOString(),
      summary: storedSummary,
      usage,
    },
    0o644,
  );

  let savedToVault = false;
  if (input?.saveToVault) {
    const password = cleanText(input?.password, 500);
    if (!password) {
      throw new Error("Password is required when saving to GPT Accounts");
    }
    await saveGptAccount({
      name: trimmedName,
      email: storedSummary.email || "",
      password,
      note: cleanText(input?.note, 2_000),
    });
    savedToVault = true;
  }

  return {
    id,
    name: trimmedName,
    summary: storedSummary,
    usage,
    savedToVault,
  };
}

async function listProfiles() {
  const entries = await fsp.readdir(PROFILES_DIR, { withFileTypes: true });
  const profileDirs = entries.filter((entry) => entry.isDirectory());
  const profiles = await Promise.all(
    profileDirs.map((entry) => loadProfileListItem(entry.name)),
  );

  profiles.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  return profiles;
}

async function countProfiles() {
  const entries = await fsp.readdir(PROFILES_DIR, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).length;
}

async function listGptAccounts() {
  const accounts = await readGptAccountsStore();
  return accounts.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

async function saveGptAccount(input) {
  const payload = normalizeGptAccountInput(input);
  if (!payload.name) {
    throw new Error("Account name is required");
  }

  const accounts = await readGptAccountsStore();
  const now = new Date().toISOString();
  const index = payload.id
    ? accounts.findIndex((account) => account.id === payload.id)
    : -1;
  const current = index >= 0 ? accounts[index] : null;
  const account = {
    id: current?.id || createProfileId(payload.name),
    name: payload.name,
    email: payload.email,
    password: payload.password,
    note: payload.note,
    createdAt: current?.createdAt || now,
    updatedAt: now,
  };

  if (index >= 0) {
    accounts[index] = account;
  } else {
    accounts.push(account);
  }

  await writeJsonAtomic(GPT_ACCOUNTS_PATH, accounts, 0o600);
  return account;
}

async function deleteGptAccount(id) {
  const safeId = String(id || "").trim();
  if (!safeId) {
    throw new Error("Account id is required");
  }

  const accounts = await readGptAccountsStore();
  const account = accounts.find((item) => item.id === safeId);
  if (!account) {
    throw new Error(`GPT account "${safeId}" does not exist`);
  }

  const nextAccounts = accounts.filter((item) => item.id !== safeId);
  await writeJsonAtomic(GPT_ACCOUNTS_PATH, nextAccounts, 0o600);
  return {
    message: `Deleted GPT account "${account.name}"`,
  };
}

async function readGptAccountsStore() {
  try {
    const raw = await fsp.readFile(GPT_ACCOUNTS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map(normalizeStoredGptAccount)
      .filter(Boolean);
  } catch {
    return [];
  }
}

function normalizeGptAccountInput(input) {
  return {
    id: sanitizeOptionalId(input?.id),
    name: cleanText(input?.name, 120),
    email: cleanText(input?.email, 200),
    password: cleanText(input?.password, 500),
    note: cleanText(input?.note, 2_000),
  };
}

function normalizeStoredGptAccount(input) {
  const normalized = {
    id: sanitizeOptionalId(input?.id),
    name: cleanText(input?.name, 120),
    email: cleanText(input?.email, 200),
    password: cleanText(input?.password, 500),
    note: cleanText(input?.note, 2_000),
    createdAt: normalizeTimestamp(input?.createdAt),
    updatedAt: normalizeTimestamp(input?.updatedAt),
  };

  if (!normalized.id || !normalized.name) {
    return null;
  }

  return normalized;
}

async function loadRotationSettings() {
  try {
    const raw = await fsp.readFile(SETTINGS_PATH, "utf8");
    return normalizeRotationSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_ROTATION_SETTINGS };
  }
}

async function saveRotationSettings(input) {
  const settings = normalizeRotationSettings(input);
  await writeJsonAtomic(SETTINGS_PATH, settings, 0o644);
  return settings;
}

function normalizeRotationSettings(input) {
  return {
    enabled:
      typeof input?.enabled === "boolean"
        ? input.enabled
        : DEFAULT_ROTATION_SETTINGS.enabled,
    sessionThreshold: clampInteger(
      input?.sessionThreshold,
      1,
      99,
      DEFAULT_ROTATION_SETTINGS.sessionThreshold,
    ),
    weeklyThreshold: clampInteger(
      input?.weeklyThreshold,
      1,
      99,
      DEFAULT_ROTATION_SETTINGS.weeklyThreshold,
    ),
    cooldownMinutes: clampInteger(
      input?.cooldownMinutes,
      5,
      720,
      DEFAULT_ROTATION_SETTINGS.cooldownMinutes,
    ),
    desktopNotifications:
      typeof input?.desktopNotifications === "boolean"
        ? input.desktopNotifications
        : DEFAULT_ROTATION_SETTINGS.desktopNotifications,
  };
}

async function loadProfileListItem(dirName) {
  const profileDir = path.join(PROFILES_DIR, dirName);
  const metaPath = path.join(profileDir, "meta.json");
  const authPath = path.join(profileDir, "auth.json");

  try {
    const [metaRaw, authRaw] = await Promise.all([
      fsp.readFile(metaPath, "utf8"),
      fsp.readFile(authPath, "utf8"),
    ]);
    const meta = JSON.parse(metaRaw);
    const auth = JSON.parse(authRaw);
    const summary = summarizeAuth(auth);
    const cachedUsage = normalizeUsageSnapshot(meta.usage);
    const liveUsage = await getLiveUsageSnapshot({
      auth,
      accountId: summary.accountId || null,
      persistAuthPath: authPath,
      allowCliFallback: false,
    });

    return {
      id: meta.id,
      name: meta.name,
      createdAt: meta.createdAt,
      summary,
      usage: liveUsage || cachedUsage,
    };
  } catch {
    return {
      id: dirName,
      name: dirName,
      createdAt: null,
      summary: makeEmptySummary(),
      usage: null,
    };
  }
}

async function switchProfile(profileId) {
  const profile = await getProfile(profileId);
  const auth = await readJson(profile.authPath);
  const before = await readActiveAuth();
  const summary = summarizeAuth(auth);

  if (before) {
    await backupAuth(before, `before-switch-${profileId}`);
  }

  await fsp.mkdir(CODEX_HOME, { recursive: true });
  await writeJsonAtomic(AUTH_PATH, auth, 0o600);

  const dbReset = await clearRemoteControlEnrollments();
  const usage = await getLiveUsageSnapshot({
    auth,
    force: true,
    accountId: summary.accountId || null,
    persistAuthPath: AUTH_PATH,
    allowCliFallback: true,
  });
  const persistedAuth = (await readActiveAuth()) || auth;
  const persistedSummary = summarizeAuth(persistedAuth);
  await writeJsonAtomic(profile.authPath, persistedAuth, 0o600);
  await updateProfileMeta(profile, {
    summary: persistedSummary,
    usage,
    lastSwitchedAt: new Date().toISOString(),
  });
  const codexProbe = await runCodexPostSwitchProbe();

  return {
    message: `Switched active Codex auth to "${profile.meta.name}"`,
    active: persistedSummary,
    usage,
    profile: {
      id: profile.meta.id,
      name: profile.meta.name,
    },
    notes: [
      "New Codex sessions should use the new account immediately.",
      "Existing Codex/VS Code sessions may need restart to pick up the new auth.",
      dbReset,
      codexProbe,
    ],
  };
}

async function deleteProfile(profileId) {
  const profile = await getProfile(profileId);
  await fsp.rm(profile.dir, { recursive: true, force: true });

  return {
    message: `Deleted profile "${profile.meta.name}"`,
  };
}

async function startDeviceAuth(input) {
  if (deviceAuthState.running) {
    throw new Error("A device-auth login is already running");
  }

  const profileName = cleanText(input?.name, 120);
  if (!profileName) {
    throw new Error("Profile name is required");
  }

  resetDeviceAuthState();
  deviceAuthState.running = true;
  deviceAuthState.status = "starting";
  deviceAuthState.profileName = profileName;
  deviceAuthState.startedAt = new Date().toISOString();
  deviceAuthState.message = "Launching Codex device authorization...";

  const child = spawn(CODEX_BIN, ["login", "--device-auth"], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      CODEX_HOME,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  deviceAuthState.process = child;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => updateDeviceAuthFromOutput(chunk));
  child.stderr.on("data", (chunk) => updateDeviceAuthFromOutput(chunk, true));
  child.on("error", (error) => {
    finalizeDeviceAuthFailure(error.message);
  });
  child.on("close", async (code, signal) => {
    deviceAuthState.process = null;
    deviceAuthState.running = false;

    if (deviceAuthState.status === "cancelled") {
      deviceAuthState.completedAt = new Date().toISOString();
      return;
    }

    if (code === 0) {
      try {
        const profile = await importCurrentProfile({
          name: deviceAuthState.profileName,
        });
        deviceAuthState.status = "completed";
        deviceAuthState.completedAt = new Date().toISOString();
        deviceAuthState.message = `Logged in via Codex and saved profile "${profile.name}".`;
        return;
      } catch (error) {
        finalizeDeviceAuthFailure(
          `Login finished but profile import failed: ${error.message}`,
        );
        return;
      }
    }

    const reason = signal
      ? `Device-auth stopped by signal ${signal}.`
      : `Device-auth exited with code ${code}.`;
    finalizeDeviceAuthFailure(deviceAuthState.error || reason);
  });

  return getDeviceAuthSnapshot();
}

function cancelDeviceAuth() {
  if (!deviceAuthState.process || !deviceAuthState.running) {
    return {
      message: "No device-auth login is running.",
      deviceAuth: getDeviceAuthSnapshot(),
    };
  }

  deviceAuthState.status = "cancelled";
  deviceAuthState.message = "Device-auth login cancelled.";
  deviceAuthState.completedAt = new Date().toISOString();
  deviceAuthState.process.kill("SIGINT");

  return {
    message: "Cancelled device-auth login.",
    deviceAuth: getDeviceAuthSnapshot(),
  };
}

function updateDeviceAuthFromOutput(chunk, isError = false) {
  const text = stripAnsi(String(chunk || ""));
  if (!text.trim()) {
    return;
  }

  const urlMatch = text.match(/https:\/\/auth\.openai\.com\/\S+/);
  if (urlMatch) {
    deviceAuthState.verificationUri = urlMatch[0];
  }

  const codeMatch = text.match(/\b[A-Z0-9]{4,}-[A-Z0-9]{4,}\b/);
  if (codeMatch) {
    deviceAuthState.userCode = codeMatch[0];
  }

  const expiryMatch = text.match(/expires in\s+(\d+)\s+minutes?/i);
  if (expiryMatch) {
    const minutes = Number(expiryMatch[1]);
    if (Number.isFinite(minutes)) {
      deviceAuthState.expiresAt = new Date(
        Date.now() + minutes * 60 * 1000,
      ).toISOString();
    }
  }

  if (deviceAuthState.verificationUri && deviceAuthState.userCode) {
    deviceAuthState.status = "awaiting_confirmation";
    deviceAuthState.message = "Open the device login page and enter the code shown below.";
  }

  if (isError) {
    deviceAuthState.error = text.trim();
  }
}

function stripAnsi(value) {
  return String(value || "").replace(
    /[\u001B\u009B][[\]()#;?]*(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~])/g,
    "",
  );
}

function finalizeDeviceAuthFailure(message) {
  deviceAuthState.process = null;
  deviceAuthState.running = false;
  deviceAuthState.status = "failed";
  deviceAuthState.completedAt = new Date().toISOString();
  deviceAuthState.error = String(message || "Device-auth failed");
  deviceAuthState.message = deviceAuthState.error;
}

function resetDeviceAuthState() {
  deviceAuthState.process = null;
  deviceAuthState.running = false;
  deviceAuthState.status = "idle";
  deviceAuthState.profileName = "";
  deviceAuthState.startedAt = null;
  deviceAuthState.expiresAt = null;
  deviceAuthState.completedAt = null;
  deviceAuthState.verificationUri = null;
  deviceAuthState.userCode = null;
  deviceAuthState.message = "";
  deviceAuthState.error = "";
}

function getDeviceAuthSnapshot() {
  return {
    running: deviceAuthState.running,
    status: deviceAuthState.status,
    profileName: deviceAuthState.profileName || null,
    startedAt: deviceAuthState.startedAt,
    expiresAt: deviceAuthState.expiresAt,
    completedAt: deviceAuthState.completedAt,
    verificationUri: deviceAuthState.verificationUri,
    userCode: deviceAuthState.userCode,
    message: deviceAuthState.message || null,
    error: deviceAuthState.error || null,
  };
}

async function getProfile(profileId) {
  const safeId = String(profileId || "").trim();
  if (!safeId) {
    throw new Error("Profile id is required");
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(safeId)) {
    throw new Error("Invalid profile id");
  }

  const dir = path.join(PROFILES_DIR, safeId);
  const authPath = path.join(dir, "auth.json");
  const metaPath = path.join(dir, "meta.json");

  const [authExists, metaExists] = await Promise.all([
    exists(authPath),
    exists(metaPath),
  ]);

  if (!authExists || !metaExists) {
    throw new Error(`Profile "${safeId}" does not exist`);
  }

  return {
    dir,
    authPath,
    meta: await readJson(metaPath),
  };
}

async function updateProfileMeta(profile, changes) {
  const metaPath = path.join(profile.dir, "meta.json");
  const nextMeta = {
    ...profile.meta,
    ...changes,
  };
  await writeJsonAtomic(metaPath, nextMeta, 0o644);
  return nextMeta;
}

async function backupAuth(auth, reason) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `${timestamp}-${sanitizeFilePart(reason)}.json`;
  await writeJsonAtomic(path.join(BACKUPS_DIR, name), auth, 0o600);
}

async function clearRemoteControlEnrollments() {
  if (!(await exists(STATE_DB_PATH))) {
    return "state_5.sqlite not found, skipped app-server enrollment reset.";
  }

  return new Promise((resolve) => {
    execFile(
      "sqlite3",
      [
        STATE_DB_PATH,
        "PRAGMA busy_timeout=1000; DELETE FROM remote_control_enrollments; SELECT COUNT(*) FROM remote_control_enrollments;",
      ],
      (error, stdout) => {
        if (error) {
          resolve("Could not clear remote_control_enrollments; switch still completed.");
          return;
        }

        const lines = String(stdout)
          .trim()
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        const count = Number(lines.at(-1));

        if (count === 0) {
          resolve(
            "Cleared remote_control_enrollments to avoid stale account-linked app-server state.",
          );
          return;
        }

        resolve(
          "Could not verify remote_control_enrollments cleanup; switch still completed.",
        );
      },
    );
  });
}

async function readJson(filePath) {
  const raw = await fsp.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function writeJsonAtomic(filePath, value, mode) {
  const dir = path.dirname(filePath);
  const tempPath = path.join(
    dir,
    `.tmp-${path.basename(filePath)}-${crypto.randomUUID()}`,
  );

  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await fsp.rename(tempPath, filePath);
  await fsp.chmod(filePath, mode);
}

async function exists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function getLiveUsageSnapshot({
  auth = null,
  force = false,
  accountId = null,
  persistAuthPath = null,
  allowCliFallback = false,
} = {}) {
  const cacheKey = makeUsageCacheKey(auth, accountId, allowCliFallback);
  const now = Date.now();
  const cached = usageCache.get(cacheKey);

  if (!force && cached && now < cached.expiresAt) {
    return cached.value;
  }

  if (!force && cached?.promise) {
    return cached.promise;
  }

  const promise = fetchLiveUsageSnapshot({
    auth,
    persistAuthPath,
    allowCliFallback,
  })
    .catch((error) => {
      console.warn(`Usage snapshot unavailable: ${error.message}`);
      return null;
    })
    .then((snapshot) => {
      usageCache.set(cacheKey, {
        value: snapshot,
        expiresAt: Date.now() + USAGE_CACHE_TTL_MS,
        promise: null,
      });
      return snapshot;
    });

  usageCache.set(cacheKey, {
    value: cached?.value || null,
    expiresAt: cached?.expiresAt || 0,
    promise,
  });

  return promise;
}

function makeUsageCacheKey(auth, accountId, allowCliFallback) {
  const tokenSource =
    auth?.tokens?.refresh_token ||
    auth?.tokens?.access_token ||
    auth?.OPENAI_API_KEY ||
    accountId ||
    "anonymous";
  const digest = crypto.createHash("sha1").update(String(tokenSource)).digest("hex");
  return `${allowCliFallback ? "cli" : "oauth"}:${accountId || "unknown"}:${digest}`;
}

async function fetchLiveUsageSnapshot({
  auth,
  persistAuthPath,
  allowCliFallback,
}) {
  if (auth) {
    const oauthUsage = await fetchOAuthUsageSnapshot({
      auth,
      persistAuthPath,
    });
    if (oauthUsage) {
      return oauthUsage;
    }
  }

  if (allowCliFallback) {
    return fetchCLIUsageSnapshot();
  }

  return null;
}

async function fetchOAuthUsageSnapshot({ auth, persistAuthPath }) {
  const authForFetch = await ensureFreshOAuthAuth(auth, persistAuthPath);
  const token = authForFetch?.tokens?.access_token || authForFetch?.OPENAI_API_KEY;
  if (!token || typeof token !== "string") {
    return null;
  }

  const accountId =
    authForFetch?.tokens?.account_id || summarizeAuth(authForFetch).accountId || null;
  const usageUrl = await resolveCodexUsageUrl();
  let response = await fetchUsageResponse(usageUrl, token, accountId);

  if (
    response.status === 401 ||
    response.status === 403
  ) {
    const refreshedAuth = await refreshOAuthAuth(authForFetch, persistAuthPath);
    if (!refreshedAuth) {
      return null;
    }
    const refreshedToken =
      refreshedAuth.tokens?.access_token || refreshedAuth.OPENAI_API_KEY;
    if (!refreshedToken) {
      return null;
    }
    response = await fetchUsageResponse(
      usageUrl,
      refreshedToken,
      refreshedAuth.tokens?.account_id || summarizeAuth(refreshedAuth).accountId || null,
    );
  }

  if (!response.ok) {
    return null;
  }

  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    return null;
  }

  return parseCodexOAuthUsageSnapshot(payload);
}

async function ensureFreshOAuthAuth(auth, persistAuthPath) {
  if (!auth) {
    return null;
  }

  if (!needsOAuthRefresh(auth)) {
    return auth;
  }

  return (await refreshOAuthAuth(auth, persistAuthPath)) || auth;
}

function needsOAuthRefresh(auth) {
  const refreshToken = auth?.tokens?.refresh_token;
  if (!refreshToken) {
    return false;
  }

  const lastRefresh = Date.parse(auth?.last_refresh || "");
  if (!Number.isFinite(lastRefresh)) {
    return true;
  }

  return Date.now() - lastRefresh > TOKEN_REFRESH_THRESHOLD_MS;
}

async function refreshOAuthAuth(auth, persistAuthPath) {
  const refreshToken = auth?.tokens?.refresh_token;
  if (!refreshToken) {
    return null;
  }

  const response = await fetch("https://auth.openai.com/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: OAUTH_REFRESH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: "openid profile email",
    }),
  }).catch(() => null);

  if (!response?.ok) {
    return null;
  }

  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const nextAuth = {
    ...auth,
    tokens: {
      ...(auth.tokens || {}),
      access_token: payload.access_token || auth?.tokens?.access_token,
      refresh_token: payload.refresh_token || auth?.tokens?.refresh_token,
      id_token: payload.id_token || auth?.tokens?.id_token,
    },
    last_refresh: new Date().toISOString(),
  };

  if (persistAuthPath) {
    await writeJsonAtomic(persistAuthPath, nextAuth, 0o600);
  }

  return nextAuth;
}

async function resolveCodexUsageUrl() {
  const configuredBase = await readChatGPTBaseUrl();
  const normalized = normalizeChatGPTBaseUrl(configuredBase || DEFAULT_CHATGPT_BASE_URL);
  const path = normalized.includes("/backend-api")
    ? CHATGPT_USAGE_PATH
    : CODEX_USAGE_PATH;
  return new URL(`${normalized}${path}`);
}

async function readChatGPTBaseUrl() {
  try {
    const contents = await fsp.readFile(CONFIG_PATH, "utf8");
    return parseChatGPTBaseUrlFromConfig(contents);
  } catch {
    return null;
  }
}

function parseChatGPTBaseUrlFromConfig(contents) {
  for (const rawLine of String(contents || "").split(/\r?\n/)) {
    const line = rawLine.split("#", 1)[0].trim();
    if (!line) {
      continue;
    }
    const parts = line.split("=", 2);
    if (parts.length !== 2) {
      continue;
    }
    const key = parts[0].trim();
    if (key !== "chatgpt_base_url") {
      continue;
    }
    let value = parts[1].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value.trim() || null;
  }
  return null;
}

function normalizeChatGPTBaseUrl(value) {
  let normalized = String(value || DEFAULT_CHATGPT_BASE_URL).trim();
  while (normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  if (
    (normalized.startsWith("https://chatgpt.com") ||
      normalized.startsWith("https://chat.openai.com")) &&
    !normalized.includes("/backend-api")
  ) {
    normalized += "/backend-api";
  }
  return normalized;
}

async function fetchUsageResponse(usageUrl, token, accountId) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "User-Agent": "SwitchAccCodex",
    Accept: "application/json",
  };

  if (accountId) {
    headers["ChatGPT-Account-Id"] = accountId;
  }

  return fetch(usageUrl, {
    method: "GET",
    headers,
  }).catch((error) => {
    throw new Error(`OAuth usage request failed: ${error.message}`);
  });
}

async function fetchCLIUsageSnapshot() {
  const commands = [
    ["rate-limit", "--json"],
    ["status", "--json"],
    ["usage", "--json"],
  ];

  for (const args of commands) {
    try {
      const stdout = await execFileJson(CODEX_BIN, args, 4_000);
      const snapshot = parseUsageSnapshot(stdout, args.join(" "));
      if (snapshot) {
        return snapshot;
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function runCodexPostSwitchProbe() {
  try {
    const output = await execFileText(
      CODEX_BIN,
      ["login", "status"],
      4_000,
      {
        cwd: APP_ROOT,
        env: {
          ...process.env,
          CODEX_HOME,
        },
      },
    );

    return output
      ? `Ran codex login status after switch: ${output}.`
      : "Ran codex login status after switch.";
  } catch (error) {
    return `Could not run codex login status after switch: ${error.message}`;
  }
}

function execFileJson(file, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }

      try {
        resolve(parseLooseJson(stdout));
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

function execFileText(file, args, timeoutMs, extraOptions = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        timeout: timeoutMs,
        ...extraOptions,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(String(stderr || error.message || "Command failed").trim()),
          );
          return;
        }

        resolve(String(stdout || "").trim());
      },
    );
  });
}

function parseLooseJson(stdout) {
  const raw = String(stdout || "").trim();
  if (!raw) {
    throw new Error("Empty JSON output");
  }

  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("No JSON object found in output");
    }
    return JSON.parse(raw.slice(start, end + 1));
  }
}

function parseUsageSnapshot(payload, source) {
  const rateLimit = payload?.rate_limit || payload?.rateLimit || null;
  const credits = payload?.credits || null;
  const primaryRemaining = toFiniteNumber(
    rateLimit?.remaining_percent ?? rateLimit?.remainingPercent,
  );
  const secondaryRemaining = toFiniteNumber(
    rateLimit?.weekly_remaining_percent ?? rateLimit?.weeklyRemainingPercent,
  );
  const creditsRemaining = toFiniteNumber(credits?.remaining);

  const snapshot = {
    source,
    updatedAt: new Date().toISOString(),
    primary:
      primaryRemaining === null
        ? null
        : {
            remainingPercent: clampPercent(primaryRemaining),
            usedPercent: clampPercent(100 - primaryRemaining),
            resetsAt: normalizeTimestamp(
              rateLimit?.resets_at ?? rateLimit?.resetsAt,
            ),
          },
    secondary:
      secondaryRemaining === null
        ? null
        : {
            remainingPercent: clampPercent(secondaryRemaining),
            usedPercent: clampPercent(100 - secondaryRemaining),
            resetsAt: normalizeTimestamp(
              rateLimit?.weekly_resets_at ?? rateLimit?.weeklyResetsAt,
            ),
          },
    credits:
      creditsRemaining === null
        ? null
        : {
            remaining: creditsRemaining,
          },
  };

  return snapshot.primary || snapshot.secondary || snapshot.credits
    ? snapshot
    : null;
}

function parseCodexOAuthUsageSnapshot(payload) {
  const primaryWindow = payload?.rate_limit?.primary_window;
  const secondaryWindow = payload?.rate_limit?.secondary_window;
  const credits = payload?.credits || null;

  const snapshot = {
    source: "oauth",
    updatedAt: new Date().toISOString(),
    primary: normalizeOAuthWindow(primaryWindow),
    secondary: normalizeOAuthWindow(secondaryWindow),
    credits:
      toFiniteNumber(credits?.balance) === null
        ? null
        : {
            remaining: toFiniteNumber(credits.balance),
            hasCredits: Boolean(credits?.has_credits),
            unlimited: Boolean(credits?.unlimited),
          },
  };

  return snapshot.primary || snapshot.secondary || snapshot.credits
    ? snapshot
    : null;
}

function normalizeOAuthWindow(window) {
  if (!window || typeof window !== "object") {
    return null;
  }

  const usedPercent = toFiniteNumber(window.used_percent);
  const resetAt = toFiniteNumber(window.reset_at);
  const windowSeconds = toFiniteNumber(window.limit_window_seconds);
  if (usedPercent === null || resetAt === null) {
    return null;
  }

  return {
    remainingPercent: clampPercent(100 - usedPercent),
    usedPercent: clampPercent(usedPercent),
    resetsAt: new Date(resetAt * 1000).toISOString(),
    windowMinutes:
      windowSeconds === null ? null : Math.max(0, Math.round(windowSeconds / 60)),
  };
}

function normalizeUsageSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    return null;
  }

  const primaryRemaining = toFiniteNumber(
    snapshot.primary?.remainingPercent ?? snapshot.primary?.remaining_percent,
  );
  const secondaryRemaining = toFiniteNumber(
    snapshot.secondary?.remainingPercent ?? snapshot.secondary?.remaining_percent,
  );
  const creditsRemaining = toFiniteNumber(snapshot.credits?.remaining);

  const normalized = {
    source: typeof snapshot.source === "string" ? snapshot.source : null,
    updatedAt: normalizeTimestamp(snapshot.updatedAt || snapshot.updated_at),
    primary:
      primaryRemaining === null
        ? null
        : {
            remainingPercent: clampPercent(primaryRemaining),
            usedPercent: clampPercent(100 - primaryRemaining),
            windowMinutes: toFiniteNumber(
              snapshot.primary?.windowMinutes ?? snapshot.primary?.window_minutes,
            ),
            resetsAt: normalizeTimestamp(
              snapshot.primary?.resetsAt || snapshot.primary?.resets_at,
            ),
          },
    secondary:
      secondaryRemaining === null
        ? null
        : {
            remainingPercent: clampPercent(secondaryRemaining),
            usedPercent: clampPercent(100 - secondaryRemaining),
            windowMinutes: toFiniteNumber(
              snapshot.secondary?.windowMinutes ?? snapshot.secondary?.window_minutes,
            ),
            resetsAt: normalizeTimestamp(
              snapshot.secondary?.resetsAt || snapshot.secondary?.resets_at,
            ),
          },
    credits:
      creditsRemaining === null
        ? null
        : {
            remaining: creditsRemaining,
            hasCredits: Boolean(snapshot.credits?.hasCredits ?? snapshot.credits?.has_credits),
            unlimited: Boolean(snapshot.credits?.unlimited),
          },
  };

  return normalized.primary || normalized.secondary || normalized.credits
    ? normalized
    : null;
}

function toFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, value));
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

async function checkAndNotifyRotationSuggestion() {
  if (rotationMonitorState.running) {
    return;
  }

  rotationMonitorState.running = true;
  rotationMonitorState.lastCheckedAt = Date.now();
  try {
    const settings = await loadRotationSettings();
    if (!settings.enabled || !settings.desktopNotifications) {
      rotationMonitorState.lastNotificationOutcome = "notifications disabled";
      return;
    }

    const activeAuth = await readActiveAuth();
    if (!activeAuth) {
      return;
    }

    const activeSummary = summarizeAuth(activeAuth);
    const activeUsage = await getLiveUsageSnapshot({
      auth: activeAuth,
      accountId: activeSummary.accountId || null,
      persistAuthPath: AUTH_PATH,
      allowCliFallback: true,
    });
    const profiles = await listProfiles();
    const suggestion = evaluateRotationSuggestion({
      active: activeSummary,
      usage: activeUsage,
      profiles,
      settings,
    });

    if (!suggestion) {
      rotationMonitorState.lastSignature = "";
      rotationMonitorState.lastSuggestionTitle = "";
      rotationMonitorState.lastNotificationOutcome = "no candidate matched current thresholds";
      return;
    }

    rotationMonitorState.lastSuggestionTitle = suggestion.title;

    const now = Date.now();
    if (
      suggestion.signature === rotationMonitorState.lastSignature &&
      now - rotationMonitorState.lastNotifiedAt <
        settings.cooldownMinutes * 60 * 1000
    ) {
      rotationMonitorState.lastNotificationOutcome = "cooldown active, notification skipped";
      return;
    }

    const outcome = await sendLinuxDesktopNotification(suggestion);
    rotationMonitorState.lastNotificationOutcome = outcome;
    if (!outcome.includes("failed")) {
      rotationMonitorState.lastSignature = suggestion.signature;
      rotationMonitorState.lastNotifiedAt = now;
    }
  } finally {
    rotationMonitorState.running = false;
  }
}

function evaluateRotationSuggestion({ active, usage, profiles, settings }) {
  const activeIdentity = getIdentityKey(active);
  if (!activeIdentity || !usage?.primary) {
    return null;
  }

  const sessionRemaining = usage.primary.remainingPercent;
  const weeklyRemaining = usage.secondary?.remainingPercent;
  const sessionTriggered =
    typeof sessionRemaining === "number" &&
    sessionRemaining <= settings.sessionThreshold;
  const weeklyTriggered =
    typeof weeklyRemaining === "number" &&
    weeklyRemaining <= settings.weeklyThreshold;

  if (!sessionTriggered && !weeklyTriggered) {
    return null;
  }

  const candidates = profiles
    .filter((profile) => getIdentityKey(profile.summary) !== activeIdentity)
    .map((profile) => ({
      ...profile,
      score: scoreRotationProfile(profile, settings),
    }))
    .filter((profile) => profile.score > 0)
    .sort((a, b) => b.score - a.score);

  const target = candidates[0];
  if (!target?.usage?.primary) {
    return null;
  }

  const currentName = resolveRotationAccountName(active, profiles);
  const reason = sessionTriggered ? "session" : "weekly";

  return {
    signature: `${active.accountId}:${target.id}:${reason}:${Math.round(sessionRemaining || 0)}:${Math.round(weeklyRemaining || 0)}`,
    title: sessionTriggered
      ? `${currentName} is running low`
      : `${currentName} is near weekly exhaustion`,
    message: sessionTriggered
      ? `${currentName} only has ${Math.round(sessionRemaining)}% session left. Switch to ${target.name}.`
      : `${currentName} only has ${Math.round(weeklyRemaining)}% weekly left. Switch to ${target.name}.`,
    targetId: target.id,
    targetName: target.name,
    targetLabel: describeRotationWindow(target.usage.primary),
  };
}

function scoreRotationProfile(profile, settings) {
  const session = profile.usage?.primary?.remainingPercent;
  const weekly = profile.usage?.secondary?.remainingPercent;
  const updatedAt = Date.parse(profile.usage?.updatedAt || "");
  const freshnessPenaltyMinutes = Number.isFinite(updatedAt)
    ? (Date.now() - updatedAt) / 60000
    : 1_000;

  if (typeof session !== "number" || session <= settings.sessionThreshold) {
    return -1;
  }

  if (typeof weekly === "number" && weekly <= settings.weeklyThreshold) {
    return -1;
  }

  return (
    session * 4 +
    (typeof weekly === "number" ? weekly * 1.5 : 25) +
    Math.max(0, 40 - freshnessPenaltyMinutes) +
    (profile.usage?.source === "oauth" ? 20 : 0)
  );
}

function resolveRotationAccountName(active, profiles) {
  const match = profiles.find(
    (profile) => getIdentityKey(profile.summary) === getIdentityKey(active),
  );
  return match?.name || active.email || active.accountId || "Current account";
}

function describeRotationWindow(window) {
  if (!window) {
    return "fresh usage snapshot";
  }
  const percent = Math.round(window.remainingPercent);
  const reset = normalizeTimestamp(window.resetsAt);
  return reset ? `${percent}% session left, resets ${reset}` : `${percent}% session left`;
}

async function sendLinuxDesktopNotification(suggestion) {
  return new Promise((resolve) => {
    execFile(
      "notify-send",
      [
        "--app-name=Switch Acc Codex",
        "--urgency=normal",
        "--expire-time=30000",
        "--action=switch=Switch now",
        "--action=ignore=Ignore",
        suggestion.title,
        `${suggestion.message}\nSuggested target: ${suggestion.targetName} (${suggestion.targetLabel})`,
      ],
      { timeout: 40_000 },
      async (error, stdout) => {
        if (error) {
          console.warn(`notify-send failed: ${error.message}`);
          resolve("notify-send failed");
          return;
        }

        const action = String(stdout || "").trim();
        if (action === "switch") {
          try {
            await switchProfile(suggestion.targetId);
            resolve(`clicked notification and switched to ${suggestion.targetName}`);
            return;
          } catch (switchError) {
            console.warn(`notification switch failed: ${switchError.message}`);
            resolve(`notification click switch failed: ${switchError.message}`);
            return;
          }
        }

        if (action === "ignore") {
          resolve("notification ignored by user");
          return;
        }

        resolve("notification dismissed with no switch");
      },
    );
  });
}

function createProfileId(name) {
  const slug = sanitizeFilePart(name)
    .toLowerCase()
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "profile";
  return `${slug}-${Date.now()}`;
}

function sanitizeFilePart(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]+/g, "-");
}

function sanitizeOptionalId(value) {
  const normalized = String(value || "").trim();
  return /^[a-zA-Z0-9_-]+$/.test(normalized) ? normalized : "";
}

function cleanText(value, maxLength) {
  const normalized = String(value || "").replace(/\r\n/g, "\n").trim();
  return normalized.slice(0, maxLength);
}

function getIdentityKey(summary) {
  if (!summary || typeof summary !== "object") {
    return "";
  }
  return summary.userId || summary.email || summary.accountId || "";
}

function getRotationMonitorSnapshot() {
  return {
    running: rotationMonitorState.running,
    lastCheckedAt:
      rotationMonitorState.lastCheckedAt > 0
        ? new Date(rotationMonitorState.lastCheckedAt).toISOString()
        : null,
    lastSuggestionTitle: rotationMonitorState.lastSuggestionTitle || null,
    lastNotificationOutcome: rotationMonitorState.lastNotificationOutcome || null,
    lastNotifiedAt:
      rotationMonitorState.lastNotifiedAt > 0
        ? new Date(rotationMonitorState.lastNotifiedAt).toISOString()
        : null,
  };
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
