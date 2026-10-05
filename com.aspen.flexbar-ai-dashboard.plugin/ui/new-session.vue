<template>
  <div class="key-config">
    <v-card class="mx-auto key-card" max-width="720" variant="flat" color="transparent">
      <v-card-item prepend-icon="mdi-message-plus-outline" title="New Codex Session" subtitle="Tap the key to open a new session in the ChatGPT app." class="px-0 py-1">
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
