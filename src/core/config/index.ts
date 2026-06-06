export {
  resolveUserProfileDir,
  getGlobalConfigPaths,
  getLocalConfigPath,
} from './user_profile.js';
export type { GlobalConfigPaths } from './user_profile.js';

export { parseEnvContent, loadEnvFile } from './env_file.js';

export {
  parseRegistryObject,
  mergeRegistries,
  isSecretKey,
  safeHost,
} from './provider_registry.js';
export type {
  ModelEntry,
  ProviderEntry,
  FlashDefaults,
  ProviderRegistry,
  ParsedRegistry,
  ConfigOrigin,
  MergedProvider,
  MergedField,
  MergedFlashDefaults,
  MergedRegistry,
} from './provider_registry.js';

export {
  resolveFlashConfig,
  ensureLocalConfig,
  rememberLiveSelection,
  syncConfig,
  writeConfigResolution,
  getConfigPaths,
} from './config_service.js';
export {
  readCodeGraphTransportSetting,
  writeCodeGraphTransportSetting,
  resetCodeGraphTransportSetting,
} from './codegraph_transport_config.js';
export type {
  CodeGraphTransportSetting,
  CodeGraphTransportSettingSource,
  WriteCodeGraphTransportSettingResult,
} from './codegraph_transport_config.js';
export {
  readCodeGraphBinarySetting,
  writeCodeGraphBinarySetting,
  resetCodeGraphBinarySetting,
  InvalidCodeGraphBinaryError,
} from './codegraph_binary_config.js';
export type {
  CodeGraphBinarySetting,
  CodeGraphBinarySettingSource,
  WriteCodeGraphBinarySettingResult,
} from './codegraph_binary_config.js';
export {
  readDesktopAutoApproveEnabledSetting,
  readDesktopCodeGraphModeSetting,
  readDesktopTaskNormalizerEnabledSetting,
  resetDesktopAutoApproveEnabledSetting,
  resetDesktopCodeGraphModeSetting,
  resetDesktopTaskNormalizerEnabledSetting,
  writeDesktopAutoApproveEnabledSetting,
  writeDesktopCodeGraphModeSetting,
  writeDesktopTaskNormalizerEnabledSetting,
} from './desktop_settings_config.js';
export type {
  DesktopBooleanSetting,
  DesktopCodeGraphModeSetting,
  DesktopCodeGraphModeSettingValue,
  DesktopSettingSource,
  WriteDesktopBooleanSettingResult,
  WriteDesktopCodeGraphModeSettingResult,
} from './desktop_settings_config.js';
export {
  AGENT_GUIDANCE_CONFIG_FILENAME,
  AGENT_GUIDANCE_SCHEMA_VERSION,
  buildEffectiveAgentGuidance,
  defaultAgentGuidanceConfig,
  defaultAgentGuidanceTerminalPreflightConfig,
  getAgentGuidanceConfigPath,
  normalizeTerminalPreflightForWrite,
  readAgentGuidanceConfig,
  resetAgentGuidanceConfig,
  writeAgentGuidanceConfig,
} from './agent_guidance_config.js';
export type {
  AgentGuidanceConfig,
  AgentGuidanceConfigError,
  AgentGuidanceConfigSource,
  AgentGuidanceMcpToolMetadata,
  AgentGuidanceScope,
  AgentGuidanceTerminalPreflightConfig,
  AgentGuidanceTerminalPreflightMode,
  EffectiveAgentGuidance,
  EffectiveAgentGuidanceToolNote,
  ReadAgentGuidanceConfigResult,
  WriteAgentGuidanceConfigResult,
} from './agent_guidance_config.js';
export type {
  FieldSource,
  SelectedConfigSource,
  ConfigErrorCode,
  ConfigSourceMap,
  ProviderModelSummary,
  ProviderSummary,
  ConfigResolution,
  CliConfigFlags,
  ResolveFlashConfigInput,
  ResolveFlashConfigResult,
  ConfigPaths,
  EnsureLocalConfigResult,
  SyncConfigResult,
} from './config_service.js';
