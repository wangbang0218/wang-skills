export const HOOK_STATUS_MESSAGE = "implement-with-kimi context recovery";
const SESSION_MATCHER = "^(startup|resume|clear|compact)$";

export function mergeHookConfig(input, command) {
  const config = structuredClone(input ?? {});
  config.hooks ??= {};
  config.hooks.SessionStart ??= [];
  let alreadyPresent = false;
  config.hooks.SessionStart = config.hooks.SessionStart.map((group) => {
    if (!Array.isArray(group.hooks)) return group;
    let changed = false;
    const hooks = group.hooks.map((handler) => {
      if (handler.statusMessage !== HOOK_STATUS_MESSAGE) return handler;
      alreadyPresent = true;
      if (handler.command === command) return handler;
      changed = true;
      return { ...handler, command };
    });
    return changed ? { ...group, hooks } : group;
  });
  if (!alreadyPresent) {
    config.hooks.SessionStart.push({
      matcher: SESSION_MATCHER,
      hooks: [
        {
          type: "command",
          command,
          timeout: 5,
          statusMessage: HOOK_STATUS_MESSAGE,
          additionalContextLimit: 1000,
        },
      ],
    });
  }
  return config;
}

export function removeHookConfig(input) {
  const config = structuredClone(input ?? {});
  if (!config.hooks?.SessionStart) return config;
  config.hooks.SessionStart = config.hooks.SessionStart
    .map((group) => ({
      ...group,
      hooks: Array.isArray(group.hooks)
        ? group.hooks.filter((handler) => handler.statusMessage !== HOOK_STATUS_MESSAGE)
        : group.hooks,
    }))
    .filter((group) => !Array.isArray(group.hooks) || group.hooks.length > 0);
  if (config.hooks.SessionStart.length === 0) delete config.hooks.SessionStart;
  return config;
}
