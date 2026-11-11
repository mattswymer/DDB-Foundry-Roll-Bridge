(() => {
  const MODULE_ID = "ddb-direct-roll-bridge";
  const SETTING_KEY = "actorMappings";

  function parseCharacterId(value) {
    const input = String(value || "").trim();
    if (/^[0-9]+$/.test(input)) return input;
    const match = input.match(/characters\/([0-9]+)/i);
    return match?.[1] || null;
  }

  Hooks.once("init", () => {
    game.settings.register(MODULE_ID, SETTING_KEY, {
      name: "D&D Beyond Character Mappings",
      hint: "Maps D&D Beyond character IDs to Foundry actors. Managed in the Character Mappings submenu.",
      scope: "world",
      config: false,
      type: Object,
      default: {}
    });

    const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

    class DDBActorMappingConfig extends HandlebarsApplicationMixin(ApplicationV2) {
      static DEFAULT_OPTIONS = {
        id: "ddb-direct-roll-bridge-actor-mappings",
        tag: "form",
        window: { title: "D&D Beyond Character Mappings", icon: "fa-solid fa-link" },
        position: { width: 680, height: "auto" },
        form: { handler: this.#onSubmit, closeOnSubmit: true },
        actions: {
          addMapping: this.#addMapping,
          removeMapping: this.#removeMapping
        }
      };

      static PARTS = {
        main: { template: "modules/ddb-direct-roll-bridge/templates/actor-mappings.hbs" }
      };

      async _prepareContext() {
        const mappings = game.settings.get(MODULE_ID, SETTING_KEY) || {};
        return {
          rows: Object.entries(mappings).map(([ddbId, actorId]) => ({ ddbId, actorId })),
          actors: game.actors.contents.filter(actor => actor.type === "character")
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(actor => ({ id: actor.id, name: actor.name, type: actor.type }))
        };
      }

      static #actorOptions(selectedId, actors) {
        const select = document.createElement("select");
        select.className = "mapping-actor";
        select.required = true;
        select.append(new Option("Select a Foundry actor…", ""));
        for (const actor of actors) {
          select.append(new Option(`${actor.name} (${actor.type})`, actor.id, false, actor.id === selectedId));
        }
        if (selectedId && !actors.some(actor => actor.id === selectedId)) {
          select.append(new Option(`Existing non-player actor (${selectedId})`, selectedId, true, true));
        }
        return select;
      }

      static #addRow(container, actors, ddbId = "", actorId = "") {
        const row = document.createElement("div");
        row.className = "ddb-mapping-row";
        const idInput = document.createElement("input");
        idInput.className = "mapping-ddb-id";
        idInput.type = "text";
        idInput.inputMode = "numeric";
        idInput.placeholder = "D&D Beyond sheet URL or character ID";
        idInput.value = ddbId;
        idInput.required = true;
        const actorSelect = this.#actorOptions(actorId, actors);
        const remove = document.createElement("button");
        remove.type = "button";
        remove.dataset.action = "removeMapping";
        remove.className = "icon";
        remove.title = "Remove mapping";
        remove.innerHTML = '<i class="fa-solid fa-trash"></i>';
        row.append(idInput, actorSelect, remove);
        container.append(row);
      }

      static #addMapping(event, target) {
        const container = this.element.querySelector(".ddb-mapping-rows");
        const actors = game.actors.contents.filter(actor => actor.type === "character")
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(actor => ({ id: actor.id, name: actor.name, type: actor.type }));
        this.constructor.#addRow(container, actors);
      }

      static #removeMapping(event, target) {
        target.closest(".ddb-mapping-row")?.remove();
      }

      static async #onSubmit(event, form) {
        const mappings = {};
        const actorIds = new Set();
        for (const row of form.querySelectorAll(".ddb-mapping-row")) {
          const ddbId = row.querySelector(".mapping-ddb-id")?.value.trim();
          const actorId = row.querySelector(".mapping-actor")?.value;
          if (!ddbId && !actorId) continue;
          if (!ddbId || !actorId) {
            ui.notifications.error("Each mapping needs both a D&D Beyond character ID and a Foundry actor.");
            return;
          }
          if (!/^[0-9]+$/.test(ddbId)) {
            ui.notifications.error(`D&D Beyond character ID "${ddbId}" must contain digits only.`);
            return;
          }
          if (Object.hasOwn(mappings, ddbId)) {
            ui.notifications.error(`D&D Beyond character ID "${ddbId}" is listed more than once.`);
            return;
          }
          if (actorIds.has(actorId)) {
            ui.notifications.error("Each Foundry actor can only be assigned to one D&D Beyond character.");
            return;
          }
          mappings[ddbId] = actorId;
          actorIds.add(actorId);
        }
        await game.settings.set(MODULE_ID, SETTING_KEY, mappings);
        ui.notifications.info(`Saved ${Object.keys(mappings).length} D&D Beyond character mapping(s).`);
      }

      _onRender(context, options) {
        super._onRender(context, options);
        const container = this.element.querySelector(".ddb-mapping-rows");
        if (!container) return;
        for (const row of context.rows) {
          this.constructor.#addRow(container, context.actors, row.ddbId, row.actorId);
        }
      }
    }

    game.settings.registerMenu(MODULE_ID, "actorMappingsMenu", {
      name: "D&D Beyond Character Mappings",
      label: "Configure Character Mappings",
      hint: "Link each D&D Beyond character to its matching Foundry actor.",
      icon: "fa-solid fa-link",
      type: DDBActorMappingConfig,
      restricted: true
    });
  });
})();