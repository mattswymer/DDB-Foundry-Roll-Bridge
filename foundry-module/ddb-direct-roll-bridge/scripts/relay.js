(() => {
  const MODULE_ID = "ddb-direct-roll-bridge";
  const RELAY_URL = "https://ddb-cloud-relay-tkqqv2yyqq-ue.a.run.app";
  const MIN_PROTOCOL = 1;
  const PROFILES_KEY = "campaignProfiles";
  const ACTIVE_PROFILE_KEY = "activeCampaignProfile";
  const ADMIN_KEY_SETTING = "relayAdminKey";
  const COBALT_SESSION_SETTING = "cobaltSession";

  let adminKey = "";
  let socket = null;
  let reconnectTimer = null;
  let reconnectDelay = 2000;
  let shouldReconnect = false;

  function notifyStatus(message) {
    document.querySelector(".ddb-relay-status")?.replaceChildren(
      document.createTextNode(message)
    );
  }

  async function saveCredentials(adminInput, cobaltInput) {
    adminKey = adminInput?.value.trim() || "";
    const cobaltSession = cobaltInput?.value.trim() || "";
    await game.settings.set(MODULE_ID, ADMIN_KEY_SETTING, adminKey);
    await game.settings.set(MODULE_ID, COBALT_SESSION_SETTING, cobaltSession);
  }

  async function api(path, method = "GET", body = null) {
    if (!adminKey) throw new Error("Enter the relay admin key first.");
    const headers = { "x-relay-admin": adminKey };
    if (body !== null) headers["content-type"] = "application/json";

    const response = await fetch(`${RELAY_URL}${path}`, {
      method,
      headers,
      ...(body !== null ? { body: JSON.stringify(body) } : {})
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    return result;
  }

  function disconnectStream() {
    shouldReconnect = false;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (socket) {
      const old = socket;
      socket = null;
      old.close(1000, "Relay stopped");
    }
  }

  function connectStream() {
    if (!game.user?.isGM || !adminKey) return;
    disconnectStream();
    shouldReconnect = true;
    reconnectDelay = 2000;

    const open = () => {
      if (!shouldReconnect) return;
      const url = RELAY_URL.replace(/^https:/, "wss:") + "/stream";
      const ws = new WebSocket(url);
      socket = ws;

      ws.addEventListener("open", () => {
        if (socket === ws) {
          ws.send(JSON.stringify({ type: "auth", key: adminKey }));
        }
      });

      ws.addEventListener("message", event => {
        if (socket !== ws) return;
        let message;
        try { message = JSON.parse(event.data); } catch { return; }

        if (message.type === "status") {
          if (message.status === "stream-ready") {
            reconnectDelay = 2000;
            notifyStatus(`Connected — game ${message.gameId}`);
          } else if (message.status === "ddb-connected") {
            notifyStatus("Connected to D&D Beyond");
          }
          return;
        }

        const payload = message.payload;
        if (message.type !== "ddb-event") return;
        if (payload?.eventType !== "dice/roll/fulfilled") return;
        if (!payload?.data?.rollId) return;

        document.dispatchEvent(new CustomEvent(
          "DDB_DIRECT_ROLL_BRIDGE_WS_ROLL",
          { detail: JSON.stringify(payload) }
        ));
      });

      ws.addEventListener("close", () => {
        if (socket !== ws || !shouldReconnect) return;
        socket = null;
        notifyStatus("Disconnected; reconnecting…");
        reconnectTimer = setTimeout(open, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      });

      ws.addEventListener("error", () => notifyStatus("Relay connection error"));
    };
    open();
  }

  Hooks.once("init", () => {
    game.settings.register(MODULE_ID, PROFILES_KEY, {
      name: "D&D Beyond Campaign Profiles",
      scope: "world",
      config: false,
      type: Array,
      default: []
    });

    game.settings.register(MODULE_ID, ACTIVE_PROFILE_KEY, {
      name: "Active D&D Beyond Campaign",
      scope: "world",
      config: false,
      type: String,
      default: ""
    });

    game.settings.register(MODULE_ID, ADMIN_KEY_SETTING, {
      name: "D&D Beyond Relay Admin Key",
      scope: "client",
      config: false,
      type: String,
      default: ""
    });

    game.settings.register(MODULE_ID, COBALT_SESSION_SETTING, {
      name: "D&D Beyond CobaltSession",
      scope: "client",
      config: false,
      type: String,
      default: ""
    });

    const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

    class DDBRelayConfig extends HandlebarsApplicationMixin(ApplicationV2) {
      static DEFAULT_OPTIONS = {
        id: "ddb-direct-roll-bridge-relay",
        tag: "form",
        window: { title: "D&D Beyond Cloud Relay", icon: "fa-solid fa-cloud" },
        position: { width: 680, height: "auto" },
        form: { handler: this.#onSubmit, closeOnSubmit: false },
        actions: {
          addProfile: this.#addProfile,
          removeProfile: this.#removeProfile,
          refreshStatus: this.#refreshStatus,
          startSession: this.#startSession,
          stopSession: this.#stopSession
        }
      };

      static PARTS = {
        main: { template: "modules/ddb-direct-roll-bridge/templates/relay-config.hbs" }
      };

      async _prepareContext() {
        return {
          profiles: game.settings.get(MODULE_ID, PROFILES_KEY) || [],
          activeProfile: game.settings.get(MODULE_ID, ACTIVE_PROFILE_KEY) || "",
          adminKey: game.settings.get(MODULE_ID, ADMIN_KEY_SETTING) || "",
          cobaltSession: game.settings.get(MODULE_ID, COBALT_SESSION_SETTING) || ""
        };
      }

      static #addRow(container, profile = {}) {
        const row = document.createElement("div");
        row.className = "ddb-relay-profile-row";
        row.style.cssText = "display:grid;grid-template-columns:1fr 1fr auto;gap:8px;margin:8px 0;";

        const name = document.createElement("input");
        name.placeholder = "Campaign name";
        name.value = profile.name || "";
        name.dataset.profileName = "";

        const gameId = document.createElement("input");
        gameId.placeholder = "D&D Beyond Game ID";
        gameId.value = profile.gameId || "";
        gameId.dataset.profileGameId = "";

        const remove = document.createElement("button");
        remove.type = "button";
        remove.dataset.action = "removeProfile";
        remove.textContent = "Remove";

        row.append(name, gameId, remove);
        container.append(row);
      }

      _onRender(context, options) {
        super._onRender(context, options);
        const container = this.element.querySelector(".ddb-relay-profiles");
        container?.replaceChildren();
        for (const profile of context.profiles) {
          this.constructor.#addRow(container, profile);
        }

        const select = this.element.querySelector('[name="activeProfile"]');
        select?.replaceChildren(new Option("Select a campaign…", ""));
        for (const profile of context.profiles) {
          select?.append(new Option(
            profile.name, profile.id, false,
            profile.id === context.activeProfile
          ));
        }

        const adminInput = this.element.querySelector('[name="adminKey"]');
        const cobaltInput = this.element.querySelector('[name="cobaltSession"]');
        if (adminInput) adminInput.value = context.adminKey;
        if (cobaltInput) cobaltInput.value = context.cobaltSession;
        adminKey = context.adminKey;

        adminInput?.addEventListener("change", async () => {
          adminKey = adminInput.value.trim();
          await game.settings.set(MODULE_ID, ADMIN_KEY_SETTING, adminKey);
          notifyStatus("Admin key saved in this browser.");
        });

        cobaltInput?.addEventListener("change", async () => {
          await game.settings.set(
            MODULE_ID, COBALT_SESSION_SETTING, cobaltInput.value.trim()
          );
          notifyStatus("CobaltSession saved in this browser.");
        });
      }

      static #addProfile() {
        this.constructor.#addRow(
          this.element.querySelector(".ddb-relay-profiles")
        );
      }

      static #removeProfile(event, target) {
        target.closest(".ddb-relay-profile-row")?.remove();
      }

      static async #onSubmit(event, form) {
        const rows = [...form.querySelectorAll(".ddb-relay-profile-row")];
        const previous = game.settings.get(MODULE_ID, PROFILES_KEY) || [];
        const profiles = [];

        for (const row of rows) {
          const name = row.querySelector("[data-profile-name]").value.trim();
          const gameId = row.querySelector("[data-profile-game-id]").value.trim();
          if (!name && !gameId) continue;
          if (!name || !gameId) {
            return notifyStatus("Each campaign needs both a name and Game ID.");
          }

          const existing = previous.find(p => p.name === name && p.gameId === gameId);
          profiles.push({
            id: existing?.id || foundry.utils.randomID(),
            name,
            gameId
          });
        }

        const selected = form.querySelector('[name="activeProfile"]').value;
        await saveCredentials(
          form.querySelector('[name="adminKey"]'),
          form.querySelector('[name="cobaltSession"]')
        );

        await game.settings.set(MODULE_ID, PROFILES_KEY, profiles);
        await game.settings.set(
          MODULE_ID,
          ACTIVE_PROFILE_KEY,
          profiles.some(p => p.id === selected) ? selected : ""
        );

        notifyStatus("Campaign profiles and credentials saved in this browser.");
        this.render();
      }

      static async #refreshStatus() {
        try {
          await saveCredentials(
            this.element.querySelector('[name="adminKey"]'),
            this.element.querySelector('[name="cobaltSession"]')
          );
          const result = await api("/api/status");
          if (result.active) {
            connectStream();
            notifyStatus(`Relay active — game ${result.gameId}`);
          } else {
            disconnectStream();
            notifyStatus("Relay is inactive.");
          }
        } catch (error) {
          notifyStatus(`Status error: ${error.message}`);
        }
      }

      static async #startSession() {
        try {
          await saveCredentials(
            this.element.querySelector('[name="adminKey"]'),
            this.element.querySelector('[name="cobaltSession"]')
          );
          const profileId = this.element.querySelector('[name="activeProfile"]').value;
          const profiles = game.settings.get(MODULE_ID, PROFILES_KEY) || [];
          const profile = profiles.find(p => p.id === profileId);
          const cobaltSession = this.element.querySelector('[name="cobaltSession"]').value.trim();

          if (!adminKey) throw new Error("Enter the relay admin key.");
          if (!profile) throw new Error("Select and save a campaign profile.");
          if (!cobaltSession) throw new Error("Enter the D&D Beyond CobaltSession.");

          await api("/api/session", "POST", {
            cobaltSession,
            gameId: profile.gameId
          });

          notifyStatus(`Starting relay for ${profile.name}…`);
          connectStream();
        } catch (error) {
          notifyStatus(`Start failed: ${error.message}`);
        }
      }

      static async #stopSession() {
        try {
          await saveCredentials(
            this.element.querySelector('[name="adminKey"]'),
            this.element.querySelector('[name="cobaltSession"]')
          );
          await api("/api/session", "DELETE");
          disconnectStream();
          notifyStatus("Relay stopped.");
        } catch (error) {
          notifyStatus(`Stop failed: ${error.message}`);
        }
      }
    }

    game.settings.registerMenu(MODULE_ID, "relayConfig", {
      name: "D&D Beyond Cloud Relay",
      label: "Configure Relay",
      hint: "Manage campaign profiles and relay sessions.",
      icon: "fa-solid fa-cloud",
      type: DDBRelayConfig,
      restricted: true
    });
  });
})();
