<template>
  <div class="key-config">
    <v-card class="mx-auto key-card" max-width="720" variant="flat" color="transparent">
      <v-card-item title="New Codex Session" subtitle="Tap the key to open a new session in the ChatGPT app." class="px-0 py-1">
        <template #prepend>
          <!-- The OpenAI mark (OpenAI's trademark; path and source in src/dashboard/openaiLogo.js), as on the key-library icon; it only identifies the data source. -->
          <span class="openai-key-icon openai-key-icon--badged" style="--badge-color: #22c55e" aria-hidden="true">
            <svg class="openai-key-icon__mark" viewBox="0 0 24 24" focusable="false">
              <path fill="currentColor" d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
            </svg>
            <span class="openai-key-icon__badge"></span>
          </span>
        </template>
        <template #append>
          <v-chip color="orange" variant="tonal" size="small">{{ modeLabel }}</v-chip>
        </template>
      </v-card-item>

      <v-card-text class="px-0 py-2">
        <v-row class="ma-n1">
          <v-col cols="12" md="5" class="pa-1">
            <div class="text-subtitle-2 mb-1">Mode</div>
            <v-btn-toggle v-model="mode" color="orange" mandatory divided variant="tonal" density="compact" class="w-100">
              <v-btn value="codex" class="flex-grow-1">Codex</v-btn>
              <v-btn value="work" class="flex-grow-1">Work</v-btn>
              <v-btn value="chat" class="flex-grow-1">Chat</v-btn>
            </v-btn-toggle>
          </v-col>

          <v-col cols="12" md="7" class="pa-1">
            <div class="text-subtitle-2 mb-1">Project folder</div>
            <div class="d-flex ga-2">
              <v-combobox
                v-model="projectPath"
                :items="recentProjects"
                placeholder="Current app project"
                color="orange"
                density="compact"
                variant="solo-filled"
                :loading="loading"
                clearable
                hide-details
              />
              <v-btn
                color="orange"
                icon="mdi-refresh"
                variant="tonal"
                density="compact"
                :loading="loading"
                @click="refreshProjects"
              />
            </div>
          </v-col>

          <v-col cols="12" class="pa-1">
            <div class="text-subtitle-2 mb-1">Starting prompt (optional)</div>
            <v-textarea
              v-model="prompt"
              placeholder="Prefilled in the composer; you still press send."
              color="orange"
              density="compact"
              variant="solo-filled"
              rows="2"
              auto-grow
              hide-details
            />
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>
  </div>
</template>

<script>
function setKeyConfigPageClass(enabled) {
  if (typeof document !== "undefined" && document.body) {
    document.body.classList.toggle("ai-dashboard-key-config", enabled);
  }
}

const MODES = ["codex", "work", "chat"];

export default {
  props: {
    modelValue: {
      type: Object,
      default: () => ({}),
    },
  },
  emits: ["update:modelValue"],
  data() {
    return {
      loading: false,
      recentProjects: [],
    };
  },
  computed: {
    mode: {
      get() {
        const value = this.configValue("mode");
        return MODES.includes(value) ? value : "codex";
      },
      set(value) {
        this.updateData({ mode: MODES.includes(value) ? value : "codex" });
      },
    },
    projectPath: {
      get() {
        return this.configValue("projectPath") || "";
      },
      set(value) {
        this.updateData({ projectPath: typeof value === "string" ? value.trim() : "" });
      },
    },
    prompt: {
      get() {
        return this.configValue("prompt") || "";
      },
      set(value) {
        this.updateData({ prompt: typeof value === "string" ? value : "" });
      },
    },
    modeLabel() {
      if (this.mode === "work") return "Work";
      if (this.mode === "chat") return "Chat";
      return "Codex";
    },
  },
  methods: {
    configValue(name) {
      const model = isObject(this.modelValue) ? this.modelValue : {};
      const data = isObject(model.data) ? model.data : {};
      const nestedConfig = isObject(data.config) ? data.config : {};
      const config = isObject(model.config) ? model.config : {};
      return config[name] ?? nestedConfig[name] ?? model[name] ?? data[name];
    },
    updateData(patch) {
      const model = isObject(this.modelValue) ? this.modelValue : {};
      const nestedModel = withoutTopLevelPatch(model, patch);
      if (isObject(model.config)) {
        this.$emit("update:modelValue", {
          ...nestedModel,
          config: {
            ...model.config,
            ...patch,
          },
        });
        return;
      }

      if (isObject(model.data) && isObject(model.data.config)) {
        this.$emit("update:modelValue", {
          ...nestedModel,
          data: {
            ...model.data,
            config: {
              ...model.data.config,
              ...patch,
            },
          },
        });
        return;
      }

      if (isFullKeyModelWithData(model)) {
        this.$emit("update:modelValue", {
          ...nestedModel,
          data: {
            ...model.data,
            ...patch,
          },
        });
        return;
      }

      this.$emit("update:modelValue", {
        ...model,
        ...patch,
      });
    },
    async refreshProjects() {
      if (!this.$fd || typeof this.$fd.sendToBackend !== "function") return;
      this.loading = true;
      try {
        const projects = await this.$fd.sendToBackend({ type: "recentProjects" });
        this.recentProjects = Array.isArray(projects) ? projects : [];
      } catch (error) {
        this.recentProjects = [];
      } finally {
        this.loading = false;
      }
    },
  },
  mounted() {
    setKeyConfigPageClass(true);
    this.refreshProjects();
  },
  beforeUnmount() {
    setKeyConfigPageClass(false);
  },
};

function isFullKeyModelWithData(model) {
  return isObject(model.data) && (
    Object.prototype.hasOwnProperty.call(model, "cid") ||
    Object.prototype.hasOwnProperty.call(model, "style") ||
    Object.prototype.hasOwnProperty.call(model, "title")
  );
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function withoutTopLevelPatch(model, patch) {
  const next = { ...model };
  for (const name of Object.keys(patch || {})) {
    delete next[name];
  }
  return next;
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

.key-config {
  min-height: 0;
  padding: 0;
  overflow: hidden;
}

.key-card {
  overflow: visible;
}

.key-config :deep(.v-btn) {
  letter-spacing: 0;
  text-transform: none;
}

:global(body.ai-dashboard-key-config) {
  margin: 0 !important;
  overflow-y: hidden !important;
}

:global(body.ai-dashboard-key-config #app),
:global(body.ai-dashboard-key-config .v-application),
:global(body.ai-dashboard-key-config .v-application__wrap),
:global(body.ai-dashboard-key-config .v-main),
:global(body.ai-dashboard-key-config .v-main__wrap) {
  min-height: 0 !important;
  overflow-y: hidden !important;
}
</style>
