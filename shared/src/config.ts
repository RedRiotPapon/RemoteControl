import { DEFAULT_SESSION_CONFIG, SessionConfig } from './types';

export function validateSessionConfig(input: Partial<SessionConfig>): SessionConfig {
  const config = { ...DEFAULT_SESSION_CONFIG, ...input };
  for (const [key, min, max] of [
    ['browserWidth', 800, 3840], ['browserHeight', 600, 2160],
    ['maxSessionDurationMinutes', 0, 1440],
    ['cpuCores', 1, 8], ['memoryLimitMB', 1024, 8192],
  ] as const) {
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) {
      throw new Error(`${key} must be a whole number between ${min} and ${max}.`);
    }
  }
  if (typeof config.containerImage !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}$/.test(config.containerImage)) {
    throw new Error('Enter a valid container image name.');
  }
  return config;
}
