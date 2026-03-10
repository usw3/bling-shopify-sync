function serializeMeta(meta) {
  try {
    return meta !== undefined ? ` ${JSON.stringify(meta)}` : "";
  } catch (error) {
    return " [unserializable meta]";
  }
}

export function createLogger(scope = "app") {
  const prefix = `[${scope}]`;

  function log(level, message, meta) {
    const metaPayload = serializeMeta(meta);
    console[level](`${prefix} ${message}${metaPayload}`);
  }

  return {
    info: (message, meta) => log("log", message, meta),
    warn: (message, meta) => log("warn", message, meta),
    error: (message, meta) => log("error", message, meta),
  };
}
