/** Public AI4Science v0.2 platform exports; Provider protocol remains version 1. Provider authors may import sdk.ts without any Harness dependency. */
export * from './sdk.ts'
export { verifyStableSubmission } from './testing.ts'
export { ExecutionEngine } from './execution.ts'
export { Artifacts } from './artifacts.ts'
export { readPlatformConfig, openConfiguredEngine, HARNESS_BASELINE, PLATFORM_VERSION } from './config.ts'

export type {
  ExperimentRequest,
  ExperimentAction,
  ExperimentAssessment,
  ExperimentView,
  ExperimentFeedback,
  ExperimentAPI,
} from './experiments.ts'
export { experimentRequestSchema } from './experiments.ts'
