<template>
  <v-container fluid class="config-page">
    <v-card variant="flat" color="transparent" class="config-card">
      <v-card-item
        title="Flexbar AI Dashboard"
        subtitle="Local Codex status used by the Flexbar keys."
        class="px-0 pt-0 pb-2"
      >
        <template #prepend>
          <!-- The OpenAI mark (OpenAI's trademark; path and source in src/dashboard/openaiLogo.js), as on the key-library icon; it only identifies the data source. -->
          <span class="openai-key-icon" aria-hidden="true">
            <svg class="openai-key-icon__mark" viewBox="0 0 24 24" focusable="false">
              <path fill="currentColor" d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
            </svg>
          </span>
        </template>
        <template #append>
          <v-chip :color="overallReady ? 'success' : 'orange'" variant="tonal" size="small">
            <v-icon start size="16">{{ overallIcon }}</v-icon>
            {{ overallText }}
          </v-chip>
        </template>
      </v-card-item>

      <v-card-text class="px-0 py-2">
        <v-alert v-if="error" type="error" density="compact" variant="tonal" class="mb-3">
          {{ error }}
        </v-alert>

        <v-list bg-color="transparent" density="compact" lines="two" class="status-list">
          <v-list-item
            v-for="item in statusItems"
            :key="item.label"
            rounded="lg"
            class="px-3"
          >
            <template #prepend>
              <v-icon :color="item.ok ? 'success' : 'orange'" size="20">
                {{ item.ok ? "mdi-check-circle-outline" : "mdi-alert-circle-outline" }}
              </v-icon>
            </template>
            <v-list-item-title>{{ item.label }}</v-list-item-title>
            <v-list-item-subtitle class="status-value" :title="item.value">
              {{ item.value }}
            </v-list-item-subtitle>
            <template #append>
              <v-chip size="x-small" :color="item.ok ? 'success' : 'orange'" variant="tonal">
                {{ item.badge }}
              </v-chip>
            </template>
          </v-list-item>
        </v-list>

        <div class="actions">
          <v-btn color="orange" variant="tonal" :loading="busy" @click="refresh">
            <v-icon start>mdi-refresh</v-icon>
            Refresh
          </v-btn>
        </div>

        <div class="dots-source mt-5">
          <div class="text-subtitle-2 mb-1">ChatGPT Dots status</div>
          <v-btn-toggle
            :model-value="dotsStatusSource"
            color="orange"
            mandatory
            divided
            variant="tonal"
            density="compact"
            :disabled="savingDots"
            @update:model-value="updateDotsStatusSource"
          >
            <v-btn value="auto">Network + cache</v-btn>
            <v-btn value="local">Local cache only</v-btn>
          </v-btn-toggle>
          <div class="text-caption text-medium-emphasis mt-2">
            <strong>Network + cache</strong> (default): the Dots key asks chatgpt.com for your dots' status with read-only
            GET requests (about every 2.5 minutes, at most 60 an hour, through the system proxy), signed in with the Codex
            login in <code>auth.json</code>. The plugin never refreshes that token; when a request fails or the token has
            expired, the key keeps its last answer with its age, or shows the ChatGPT app's local cache, marked as such.
            <strong>Local cache only</strong>: no network at all; the key reads only the app's local cache, which the app
            updates while it is in the foreground, so it may be hours old. That cache holds only your primary dot and no
            unread information, so in this mode the key cannot show <strong>Update</strong>.
          </div>
          <div v-if="dotsSaveMessage" class="text-caption text-medium-emphasis mt-1">{{ dotsSaveMessage }}</div>
        </div>
      </v-card-text>

      <v-expansion-panels variant="accordion" class="mt-2">
        <v-expansion-panel>
          <v-expansion-panel-title>
            <div class="d-inline-flex align-center ga-2">
              <v-icon size="18">mdi-folder-cog-outline</v-icon>
              Path overrides
            </div>
          </v-expansion-panel-title>
          <v-expansion-panel-text>
            <div class="text-caption text-medium-emphasis mb-3">
              Leave blank to use auto-detected paths from environment variables. Placeholders show the current resolved default.
            </div>

            <v-text-field
              v-for="field in pathFields"
              :key="field.key"
              :model-value="pathOverrides[field.key]"
              :label="field.label"
              :placeholder="field.resolved"
              :hint="fieldHint(field)"
              :error="Boolean(pathFieldErrors[field.key])"
              :error-messages="pathFieldErrors[field.key]"
              persistent-hint
              density="compact"
              variant="outlined"
              color="orange"
              hide-details="auto"
              class="mb-2 path-override-field"
              @update:model-value="updatePathOverride(field.key, $event)"
            />

            <div class="d-flex flex-wrap align-center ga-2 mt-1">
              <v-btn
                color="orange"
                variant="flat"
                :loading="savingPaths"
                :disabled="!pathOverridesDirty"
                @click="applyPathOverrides"
              >
                <v-icon start>mdi-content-save-outline</v-icon>
                Apply path overrides
              </v-btn>
              <span v-if="pathSaveMessage" class="text-caption text-medium-emphasis">
                {{ pathSaveMessage }}
              </span>
            </div>
          </v-expansion-panel-text>
        </v-expansion-panel>

        <v-expansion-panel>
          <v-expansion-panel-title>
            <div class="d-inline-flex align-center ga-2">
              <v-icon size="18">mdi-text-box-search-outline</v-icon>
              Diagnostics
            </div>
          </v-expansion-panel-title>
          <v-expansion-panel-text>
            <v-textarea
              :model-value="snapshotText"
              readonly
              auto-grow
              no-resize
              rows="4"
              density="compact"
              variant="solo-filled"
              color="orange"
              hide-details
            />
          </v-expansion-panel-text>
        </v-expansion-panel>
      </v-expansion-panels>
    </v-card>
  </v-container>
</template>

<script>
// The path overrides this version has. Older versions also saved Claude Code
// ones; they are ignored so they neither pick the settings source nor mark the form dirty.
const PATH_OVERRIDE_KEYS = ["CODEX_HOME"];
// Where the ChatGPT Dots key reads its status (plugin-wide; see src/collectors/pathOverrides.js).
const DOTS_STATUS_SOURCES = ["auto", "local"];

function setConfigPageClass(enabled) {
  if (typeof document !== "undefined" && document.body) {
    document.body.classList.toggle("ai-dashboard-config-page", enabled);
  }
}

export default {
  props: {
    modelValue: {
      type: Object,
      default: () => ({ config: {} }),
    },
  },
  emits: ["update:modelValue"],
  data() {
    return {
      busy: false,
      savingPaths: false,
      savingDots: false,
      dotsSaveMessage: "",
      error: "",
      status: {},
      snapshot: null,
      pathFields: [],
      pluginSettings: { pathOverrides: {}, dotsStatusSource: "auto" },
      savedPluginSettings: { pathOverrides: {}, dotsStatusSource: "auto" },
      pathValidationErrors: {},
      pathSaveMessage: "",
      settingsLoaded: false,
    };
  },
  computed: {
    pathFieldErrors() {
      const errors = {};
      for (const field of this.pathFields) {
        const message = this.pathValidationErrors[field.key];
        if (message) errors[field.key] = [message];
      }
      return errors;
    },
    pathOverrides() {
      const overrides = isObject(this.pluginSettings.pathOverrides)
        ? this.pluginSettings.pathOverrides
        : {};
      const normalized = {};
      for (const field of this.pathFields) {
        normalized[field.key] = typeof overrides[field.key] === "string" ? overrides[field.key] : "";
      }
      return normalized;
    },
    pathOverridesDirty() {
      // The Dots status source is saved on its own (updateDotsStatusSource).
      return JSON.stringify(this.pluginSettings.pathOverrides || {}) !== JSON.stringify(this.savedPluginSettings.pathOverrides || {});
    },
    dotsStatusSource() {
      return normalizeDotsSource(this.pluginSettings.dotsStatusSource);
    },
    statusItems() {
      const codex = this.status.codex || {};
      return [
        {
          label: "Codex home",
          ok: Boolean(codex.codexHomeExists),
          value: codex.codexHome || "-",
        },
        {
          label: "Codex auth",
          ok: Boolean(codex.authJsonExists),
          value: codex.authJsonExists ? "auth.json found" : "auth.json missing",
        },
        {
          label: "Codex sessions",
          ok: Boolean(codex.sessionsDirExists),
          value: codex.sessionsDir || "session directory missing",
        },
      ].map((item) => ({
        ...item,
        badge: item.ok ? "OK" : "Missing",
      }));
    },
    overallReady() {
      return this.statusItems.length > 0 && this.statusItems.every((item) => item.ok);
    },
    overallText() {
      return this.overallReady ? "Ready" : "Needs setup";
    },
    overallIcon() {
      return this.overallReady ? "mdi-check-circle" : "mdi-alert-circle-outline";
    },
    snapshotText() {
      return this.snapshot ? JSON.stringify(this.snapshot, null, 2) : "No snapshot yet";
    },
  },
  methods: {
    fieldHint(field) {
      const error = this.pathValidationErrors[field.key];
      if (error) return error;
      return field.description;
    },
    applyPluginSettings(config) {
      const root = isObject(config) ? config : {};
      const overrides = knownPathOverrides(root.pathOverrides);
      const dotsStatusSource = normalizeDotsSource(root.dotsStatusSource);
      this.pluginSettings = { pathOverrides: { ...overrides }, dotsStatusSource };
      this.savedPluginSettings = { pathOverrides: { ...overrides }, dotsStatusSource };
      this.settingsLoaded = true;
      this.pathValidationErrors = {};
      this.pathSaveMessage = "";
    },
    hasStoredSettings(config) {
      if (!isObject(config)) return false;
      const overrides = knownPathOverrides(config.pathOverrides);
      return PATH_OVERRIDE_KEYS.some((key) => overrides[key]) || config.dotsStatusSource === "local";
    },
    async loadInitialSettings() {
      const hosted = isObject(this.modelValue && this.modelValue.config)
        ? this.modelValue.config
        : null;
      if (this.hasStoredSettings(hosted)) {
        this.applyPluginSettings(hosted);
        return;
      }

      const remote = await this.$fd.sendToBackend({ type: "getPluginConfig" });
      this.applyPluginSettings(remote);
    },
    buildConfigPayload(settings = this.pluginSettings) {
      return {
        pathOverrides: isObject(settings.pathOverrides)
          ? { ...settings.pathOverrides }
          : {},
        dotsStatusSource: normalizeDotsSource(settings.dotsStatusSource),
      };
    },
    async commitPluginConfig(config) {
      if (typeof this.$fd.setConfig === "function") {
        await this.$fd.setConfig(config);
      }

      this.$emit("update:modelValue", {
        ...(isObject(this.modelValue) ? this.modelValue : {}),
        config,
      });
    },
    async persistPluginSettings() {
      const candidate = this.buildConfigPayload();

      try {
        const result = await this.$fd.sendToBackend({
          type: "savePluginConfig",
          config: candidate,
        });
        if (result && result.ok === false) {
          if (Array.isArray(result.errors) && result.errors.length > 0) {
            this.pathValidationErrors = errorsByField(result.errors);
            this.error = "Fix path override errors before saving.";
            return false;
          }
          throw new Error(result.error || "Failed to save plugin settings");
        }

        await this.commitPluginConfig((result && result.config) || candidate);
        this.applyPluginSettings((result && result.config) || candidate);
        this.pathValidationErrors = {};
        this.error = "";
        return true;
      } catch (error) {
        this.error = error && error.message ? error.message : String(error);
        return false;
      }
    },
    async applyPathOverrides() {
      this.savingPaths = true;
      this.pathSaveMessage = "";
      try {
        const saved = await this.persistPluginSettings();
        if (!saved) return;
        this.pathSaveMessage = "Path overrides saved.";
        await this.refresh();
      } finally {
        this.savingPaths = false;
      }
    },
    // Saved as soon as it is picked, with the saved path overrides (not the ones still being edited).
    async updateDotsStatusSource(value) {
      const next = normalizeDotsSource(value);
      const saved = normalizeDotsSource(this.savedPluginSettings.dotsStatusSource);
      this.pluginSettings = { ...this.pluginSettings, dotsStatusSource: next };
      if (next === saved) return;

      this.savingDots = true;
      this.dotsSaveMessage = "";
      const candidate = this.buildConfigPayload({ ...this.savedPluginSettings, dotsStatusSource: next });
      try {
        const result = await this.$fd.sendToBackend({ type: "savePluginConfig", config: candidate });
        if (result && result.ok === false) throw new Error(result.error || "Failed to save plugin settings");
        const config = (result && result.config) || candidate;
        await this.commitPluginConfig(config);
        const source = normalizeDotsSource(config.dotsStatusSource);
        this.savedPluginSettings = { ...this.savedPluginSettings, dotsStatusSource: source };
        this.pluginSettings = { ...this.pluginSettings, dotsStatusSource: source };
        this.error = "";
        this.dotsSaveMessage = "Dots status source saved.";
      } catch (error) {
        this.pluginSettings = { ...this.pluginSettings, dotsStatusSource: saved };
        this.error = error && error.message ? error.message : String(error);
      } finally {
        this.savingDots = false;
      }
    },
    updatePathOverride(key, value) {
      if (this.pathValidationErrors[key]) {
        const nextErrors = { ...this.pathValidationErrors };
        delete nextErrors[key];
        this.pathValidationErrors = nextErrors;
      }
      const overrides = { ...this.pathOverrides };
      overrides[key] = typeof value === "string" ? value : "";
      this.pluginSettings = {
        ...this.pluginSettings,
        pathOverrides: overrides,
      };
      this.pathSaveMessage = "";
    },
    async refresh() {
      this.busy = true;
      this.error = "";
      try {
        const [status, snapshot, pathFields] = await Promise.all([
          this.$fd.sendToBackend({ type: "setupStatus" }),
          this.$fd.sendToBackend({ type: "snapshot" }),
          this.$fd.sendToBackend({ type: "pathDefaults" }),
        ]);
        this.status = status;
        this.snapshot = snapshot;
        this.pathFields = Array.isArray(pathFields) ? pathFields : [];
      } catch (error) {
        this.error = error && error.message ? error.message : String(error);
      } finally {
        this.busy = false;
      }
    },
  },
  async mounted() {
    setConfigPageClass(true);
    this.busy = true;
    this.error = "";
    try {
      await this.loadInitialSettings();
      await this.refresh();
    } catch (error) {
      this.error = error && error.message ? error.message : String(error);
    } finally {
      this.busy = false;
    }
  },
  beforeUnmount() {
    setConfigPageClass(false);
  },
};

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function knownPathOverrides(value) {
  const overrides = isObject(value) ? value : {};
  const known = {};
  for (const key of PATH_OVERRIDE_KEYS) {
    known[key] = typeof overrides[key] === "string" ? overrides[key] : "";
  }
  return known;
}

function normalizeDotsSource(value) {
  return DOTS_STATUS_SOURCES.includes(value) ? value : "auto";
}

function errorsByField(errors) {
  const byField = {};
  for (const item of errors) {
    if (!item || !item.key || !item.message || byField[item.key]) continue;
    byField[item.key] = item.message;
  }
  return byField;
}
</script>

<style scoped>
.openai-key-icon {
  position: relative;
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 7px;
  background: #0d0d0d;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.14);
  color: #ffffff;
}

.openai-key-icon__mark {
  display: block;
  width: 18px;
  height: 18px;
}

.openai-key-icon--badged {
  align-items: flex-start;
  justify-content: flex-start;
  padding: 2px;
}

.openai-key-icon--badged .openai-key-icon__mark {
  width: 17px;
  height: 17px;
}

.openai-key-icon__badge {
  position: absolute;
  top: 15px;
  left: 15px;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: var(--badge-color);
  box-shadow: 0 0 0 1.5px #0d0d0d;
}

.config-page {
  max-width: 980px;
  padding: 16px;
  overflow: visible;
}

.config-card {
  overflow: visible;
}

.status-value {
  overflow: hidden;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
}

.config-page :deep(.v-btn) {
  letter-spacing: 0;
  text-transform: none;
}

.config-page :deep(.v-list-item) {
  margin-bottom: 4px;
}

.config-page :deep(.v-expansion-panel) {
  box-shadow: none !important;
}

.config-page :deep(.v-expansion-panel::after) {
  border: 0 !important;
}

.config-page :deep(textarea) {
  overflow-y: hidden !important;
}

.path-override-field :deep(input) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

:global(body.ai-dashboard-config-page) {
  margin: 0 !important;
}

:global(body.ai-dashboard-config-page #app),
:global(body.ai-dashboard-config-page .v-application),
:global(body.ai-dashboard-config-page .v-application__wrap),
:global(body.ai-dashboard-config-page .v-main),
:global(body.ai-dashboard-config-page .v-main__wrap) {
  min-height: 0 !important;
}

@media (max-width: 760px) {
  .config-page {
    padding: 12px;
  }
}
</style>
