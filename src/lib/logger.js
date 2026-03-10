function safeStringify(value) {
  const seen = new WeakSet();

  try {
    return JSON.stringify(value, (_key, current) => {
      if (current instanceof Error) {
        return {
          name: current.name,
          message: current.message,
          stack: current.stack,
        };
      }

      if (typeof current === "bigint") {
        return current.toString();
      }

      if (current && typeof current === "object") {
        if (seen.has(current)) {
          return "[Circular]";
        }
        seen.add(current);
      }

      return current;
    });
  } catch (_error) {
    return "\"[Unserializable]\"";
  }
}

export function createLogger(scope = "app") {
  const base = `[${scope}]`;

  function write(level, message, meta) {
    const time = new Date().toISOString();
    const detail = meta === undefined ? "" : ` ${safeStringify(meta)}`;
    const line = `${time} ${base} ${message}${detail}`;

    if (level === "error") {
      console.error(line);
      return;
    }

    if (level === "warn") {
      console.warn(line);
      return;
    }

    console.log(line);
  }

  return {
    info: (message, meta) => write("info", message, meta),
    warn: (message, meta) => write("warn", message, meta),
    error: (message, meta) => write("error", message, meta),
  };
}
