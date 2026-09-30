'use strict';

function parseTargets(text) {
  const seen = new Set();
  const targets = [];

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;

    const urlMatch = line.match(/https?:\/\/[^\s"']+/i);
    if (urlMatch) line = urlMatch[0];

    if (!/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(line)) {
      line = `https://${line}`;
    }

    let normalized;
    try {
      const url = new URL(line);
      if (!['http:', 'https:'].includes(url.protocol)) continue;
      normalized = url.toString();
    } catch {
      continue;
    }

    if (seen.has(normalized)) continue;
    seen.add(normalized);
    targets.push(normalized);
  }

  return targets;
}

module.exports = { parseTargets };
