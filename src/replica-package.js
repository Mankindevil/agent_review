import { createHash } from 'node:crypto';
import { normalizeAgentExamples } from './submission.js';
import { validateSafeUrl } from './safe-http.js';

const EXCLUSIONS = Object.freeze([
  'agent-endpoints',
  'credentials',
  'documentation-urls',
  'submitted-outputs',
  'hidden-tests',
  'reviews',
  'other-replicas'
]);
const FORBIDDEN_KEY = /^(?:auth(?:entication|orization)?|credentials?|passwords?|secrets?|tokens?|cookies?|endpoints?|providers?|documentation(?:urls?)?|metadata|signatures?|security(?:schemes)?|hiddentests?|hiddenvariants?|reviews?|scoringevidence|replicas?|otherreplicas?|replicaartifacts?|submittedoutputs?|executionevidence|executionoutputs?|modeloutputs?|capturedoutputs?|outputs?|evidence|testplan(?:id)?|sessionid)$/iu;
const CREDENTIAL_KEY_SUFFIX = /(?:token|apikey|accesskey(?:id)?|secretkey|privatekey|credentials?|passwords?|cookies?)$/u;
const PLATFORM_SCORE_KEY = /(?:model|judge|absolute|replica|humanreview|review)score/u;
const SECRET_VALUE = /(?:\bbearer\s+\S+|\b(?:authorization|cookie)\s*[:=]|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b)/iu;
const SIGNED_QUERY_KEY = /(?:^|[-_])(?:sig(?:nature)?|jwt|cookie|access[-_]?token|api[-_]?key|client[-_]?secret|authorization|token|secret|password|policy|key)(?:$|[-_])|^x-amz-(?:algorithm|credential|date|expires|security-token|signature)$/iu;
const SNAPSHOT_REFERENCE = /^snapshot_[A-Za-z0-9_-]{1,128}$/u;
const MIME_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*(?:;\s*[A-Za-z0-9!#$&^_.+-]+=[^;\s]+)*$/u;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

export function createReplicaPackage(agentCard, examples, options = {}) {
  const card = whitelistCard(agentCard);
  const prohibitedHosts = collectSensitiveCardHosts(agentCard);
  const agentExamples = packageExamples(examples, prohibitedHosts, options);
  const packageVersion = options.packageVersion ?? 'replica-package/v1';
  if (packageVersion !== 'replica-package/v1') throw new TypeError('options.packageVersion must be replica-package/v1');
  const manifest = {
    packageVersion,
    rubricVersion: requireString(options.rubricVersion, 'options.rubricVersion'),
    generatedAt: options.generatedAt === undefined ? new Date().toISOString() : requireString(options.generatedAt, 'options.generatedAt'),
    sourceHashes: {
      agentCard: hashCanonical(card),
      agentExamples: hashCanonical(agentExamples)
    },
    contentHash: '',
    exclusions: [...EXCLUSIONS]
  };
  const replicaPackage = { agent: card, agentExamples, manifest };
  manifest.contentHash = hashCanonical(contentForHash(replicaPackage));
  return assertReplicaPackageSafe(replicaPackage, [...prohibitedHosts]);
}

export function assertReplicaPackageSafe(replicaPackage, prohibitedValues = []) {
  const copy = canonicalClone(replicaPackage, 'replicaPackage');
  assertPackageShape(copy);
  const prohibitedHosts = collectProhibitedHosts(prohibitedValues);
  const prohibitedStrings = collectProhibitedStrings(prohibitedValues);
  scanPackage(copy, prohibitedHosts, prohibitedStrings, 'replicaPackage');
  if (
    copy.manifest.sourceHashes.agentCard !== hashCanonical(copy.agent) ||
    copy.manifest.sourceHashes.agentExamples !== hashCanonical(copy.agentExamples)
  ) {
    throw new TypeError('Replica package source hash integrity check failed');
  }
  const expectedHash = hashCanonical(contentForHash(copy));
  if (copy.manifest.contentHash !== expectedHash) {
    throw new TypeError('Replica package content hash integrity check failed');
  }
  return deepFreeze(copy);
}

function whitelistCard(card) {
  requireObject(card, 'agentCard');
  return {
    name: requireString(card.name, 'agentCard.name'),
    description: requireString(card.description, 'agentCard.description'),
    version: requireString(card.version, 'agentCard.version'),
    capabilities: {
      streaming: Boolean(card.capabilities?.streaming),
      pushNotifications: Boolean(card.capabilities?.pushNotifications)
    },
    defaultInputModes: stringArray(card.defaultInputModes),
    defaultOutputModes: stringArray(card.defaultOutputModes),
    skills: Array.isArray(card.skills) ? card.skills.map((skill, index) => {
      requireObject(skill, `agentCard.skills[${index}]`);
      return {
        id: requireString(skill.id, `agentCard.skills[${index}].id`),
        name: requireString(skill.name, `agentCard.skills[${index}].name`),
        description: requireString(skill.description, `agentCard.skills[${index}].description`),
        tags: stringArray(skill.tags),
        examples: stringArray(skill.examples)
      };
    }) : []
  };
}

function packageExamples(examples, prohibitedHosts, options) {
  const normalized = normalizeAgentExamples(examples);
  return normalized.map((example, exampleIndex) => ({
    id: example.id,
    name: example.name,
    turns: example.turns.map((turn, turnIndex) => {
      const parts = turn.input.parts.map((part, partIndex) => packagePart(
        part,
        prohibitedHosts,
        options,
        `agentExamples[${exampleIndex}].turns[${turnIndex}].input.parts[${partIndex}]`
      ));
      const packaged = {
        input: { parts },
        acceptanceCriteria: canonicalClone(turn.acceptanceCriteria, 'acceptanceCriteria')
      };
      if (turn.expectedDeliverable !== undefined) packaged.expectedDeliverable = turn.expectedDeliverable;
      return packaged;
    }),
    ...(example.constraints === undefined ? {} : { constraints: [...example.constraints] })
  }));
}

function packagePart(part, prohibitedHosts, options, path) {
  if (part.type !== 'url') return canonicalClone(part, path);
  const url = validatePublicUrl(part.url, prohibitedHosts, path);
  if (hasSecretLookingQuery(url)) {
    const snapshot = resolveSnapshotReference(options, part.url);
    if (!snapshot) throw new TypeError(`${path}.url has a signed or secret-looking query without a locked platform snapshot`);
    return { type: 'url', snapshot };
  }
  return canonicalClone(part, path);
}

function validatePublicUrl(rawUrl, prohibitedHosts, path) {
  let url;
  try {
    url = validateSafeUrl(rawUrl);
  } catch (error) {
    throw new TypeError(`${path}.url is not a safe public URL: ${error.message}`);
  }
  if (prohibitedHosts.has(normalizeHost(url.hostname))) {
    throw new TypeError(`${path}.url host is a prohibited Agent endpoint, provider, or documentation host`);
  }
  return url;
}

function resolveSnapshotReference(options, rawUrl) {
  const references = options.platformSnapshotReferences;
  let value;
  if (references instanceof Map) value = references.get(rawUrl);
  else if (Array.isArray(references)) {
    value = references.find((item) => item?.url === rawUrl)?.snapshot;
  } else if (references && typeof references === 'object') value = references[rawUrl];
  if (value === undefined) return null;
  return validateSnapshot(value, 'platformSnapshotReferences');
}

function validateSnapshot(value, path) {
  requireObject(value, path);
  assertKeys(value, ['reference', 'mediaType', 'byteLength', 'sha256'], path);
  if (typeof value.reference !== 'string' || !SNAPSHOT_REFERENCE.test(value.reference)) {
    throw new TypeError(`${path}.reference must be a locked one-hop snapshot reference`);
  }
  if (typeof value.mediaType !== 'string' || !MIME_TYPE.test(value.mediaType)) {
    throw new TypeError(`${path}.mediaType must be a valid MIME type`);
  }
  if (!Number.isSafeInteger(value.byteLength) || value.byteLength < 0 || value.byteLength > MAX_SNAPSHOT_BYTES) {
    throw new TypeError(`${path}.byteLength must be a safe size within the snapshot limit`);
  }
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256)) {
    throw new TypeError(`${path}.sha256 must be a lowercase SHA-256 hash`);
  }
  return canonicalClone(value, path);
}

function assertPackageShape(value) {
  requireObject(value, 'replicaPackage');
  assertKeys(value, ['agent', 'agentExamples', 'manifest'], 'replicaPackage');
  const card = value.agent;
  requireObject(card, 'replicaPackage.agent');
  assertKeys(card, ['name', 'description', 'version', 'capabilities', 'defaultInputModes', 'defaultOutputModes', 'skills'], 'replicaPackage.agent');
  requireString(card.name, 'replicaPackage.agent.name');
  requireString(card.description, 'replicaPackage.agent.description');
  requireString(card.version, 'replicaPackage.agent.version');
  requireObject(card.capabilities, 'replicaPackage.agent.capabilities');
  assertKeys(card.capabilities, ['streaming', 'pushNotifications'], 'replicaPackage.agent.capabilities');
  if (typeof card.capabilities.streaming !== 'boolean' || typeof card.capabilities.pushNotifications !== 'boolean') throw new TypeError('Replica package capabilities must be boolean');
  assertStringArray(card.defaultInputModes, 'replicaPackage.agent.defaultInputModes');
  assertStringArray(card.defaultOutputModes, 'replicaPackage.agent.defaultOutputModes');
  if (!Array.isArray(card.skills)) throw new TypeError('Replica package skills must be an array');
  card.skills.forEach((skill, index) => {
    requireObject(skill, `replicaPackage.agent.skills[${index}]`);
    assertKeys(skill, ['id', 'name', 'description', 'tags', 'examples'], `replicaPackage.agent.skills[${index}]`);
    requireString(skill.id, 'skill.id'); requireString(skill.name, 'skill.name'); requireString(skill.description, 'skill.description');
    assertStringArray(skill.tags, 'skill.tags'); assertStringArray(skill.examples, 'skill.examples');
  });
  assertExamples(value.agentExamples);
  const manifest = value.manifest;
  requireObject(manifest, 'replicaPackage.manifest');
  assertKeys(manifest, ['packageVersion', 'rubricVersion', 'generatedAt', 'sourceHashes', 'contentHash', 'exclusions'], 'replicaPackage.manifest');
  if (manifest.packageVersion !== 'replica-package/v1') throw new TypeError('Replica package version is invalid');
  requireString(manifest.rubricVersion, 'manifest.rubricVersion'); requireString(manifest.generatedAt, 'manifest.generatedAt');
  requireObject(manifest.sourceHashes, 'manifest.sourceHashes');
  assertKeys(manifest.sourceHashes, ['agentCard', 'agentExamples'], 'manifest.sourceHashes');
  for (const hash of [manifest.sourceHashes.agentCard, manifest.sourceHashes.agentExamples, manifest.contentHash]) {
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/u.test(hash)) throw new TypeError('Replica package hash is invalid');
  }
  if (!Array.isArray(manifest.exclusions) || JSON.stringify(manifest.exclusions) !== JSON.stringify(EXCLUSIONS)) throw new TypeError('Replica package exclusions are invalid');
}

function assertExamples(examples) {
  if (!Array.isArray(examples) || examples.length === 0) throw new TypeError('Replica package agentExamples must be a non-empty array');
  examples.forEach((example, exampleIndex) => {
    const path = `replicaPackage.agentExamples[${exampleIndex}]`;
    requireObject(example, path); assertKeys(example, ['id', 'name', 'turns', 'constraints'], path, ['constraints']);
    requireString(example.id, `${path}.id`); requireString(example.name, `${path}.name`);
    if (!Array.isArray(example.turns) || !example.turns.length) throw new TypeError(`${path}.turns must be non-empty`);
    if (example.constraints !== undefined) assertStringArray(example.constraints, `${path}.constraints`);
    example.turns.forEach((turn, turnIndex) => {
      const turnPath = `${path}.turns[${turnIndex}]`;
      requireObject(turn, turnPath); assertKeys(turn, ['input', 'expectedDeliverable', 'acceptanceCriteria'], turnPath, ['expectedDeliverable']);
      requireObject(turn.input, `${turnPath}.input`); assertKeys(turn.input, ['parts'], `${turnPath}.input`);
      if (!Array.isArray(turn.input.parts) || !turn.input.parts.length) throw new TypeError(`${turnPath}.input.parts must be non-empty`);
      turn.input.parts.forEach((part, partIndex) => assertPart(part, `${turnPath}.input.parts[${partIndex}]`));
      if (turn.expectedDeliverable !== undefined) requireString(turn.expectedDeliverable, `${turnPath}.expectedDeliverable`);
      if (!Array.isArray(turn.acceptanceCriteria)) throw new TypeError(`${turnPath}.acceptanceCriteria must be an array`);
    });
  });
}

function assertPart(part, path) {
  requireObject(part, path);
  if (part.type === 'url' && part.snapshot !== undefined) {
    assertKeys(part, ['type', 'snapshot'], path);
    validateSnapshot(part.snapshot, `${path}.snapshot`);
    return;
  }
  if (part.type === 'url') {
    assertKeys(part, ['type', 'url', 'mediaType', 'filename'], path, ['mediaType', 'filename']);
    requireString(part.url, `${path}.url`);
    return;
  }
  if (part.type === 'text') assertKeys(part, ['type', 'text', 'mediaType', 'filename'], path, ['mediaType', 'filename']);
  else if (part.type === 'data') assertKeys(part, ['type', 'data', 'mediaType', 'filename'], path, ['mediaType', 'filename']);
  else if (part.type === 'raw') assertKeys(part, ['type', 'raw', 'mediaType', 'filename'], path, ['mediaType', 'filename']);
  else throw new TypeError(`${path} has an unsupported part type`);
}

function scanPackage(value, prohibitedHosts, prohibitedStrings, path) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanPackage(item, prohibitedHosts, prohibitedStrings, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string') scanString(value, prohibitedHosts, prohibitedStrings, path);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (isForbiddenKey(key)) throw new TypeError(`${childPath} uses a forbidden Replica package field`);
    if (key === 'url' && isPublicExampleUrlPath(childPath)) {
      scanPublicUrl(child, prohibitedHosts, prohibitedStrings, childPath);
      continue;
    }
    scanPackage(child, prohibitedHosts, prohibitedStrings, childPath);
  }
}

function scanString(value, prohibitedHosts, prohibitedStrings, path) {
  if (isHttpUrl(value)) {
    if (!isPublicExampleUrlPath(path)) throw new TypeError(`${path} contains a URL outside a public-example URL Part`);
    scanPublicUrl(value, prohibitedHosts, prohibitedStrings, path);
    return;
  }
  scanSensitiveText(value, prohibitedStrings, path);
  scanEmbeddedUrls(value, prohibitedHosts, path);
  if (isRawPartPath(path)) {
    scanRawPayload(Buffer.from(value, 'base64').toString('utf8'), prohibitedHosts, prohibitedStrings, `${path} decoded bytes`);
  }
}

function scanPublicUrl(rawUrl, prohibitedHosts, prohibitedStrings, path) {
  scanSecretOrProhibited(rawUrl, prohibitedStrings, path);
  const url = validatePublicUrl(rawUrl, prohibitedHosts, path);
  scanSensitiveText(safeDecode(url.pathname), prohibitedStrings, `${path} pathname`);
  for (const [key, value] of url.searchParams) {
    if (SIGNED_QUERY_KEY.test(key)) throw new TypeError(`${path} exposes a signed or secret-looking query key`);
    scanSensitiveText(safeDecode(key), prohibitedStrings, `${path} query key`);
    scanSensitiveText(safeDecode(value), prohibitedStrings, `${path} query value`);
  }
}

function scanSensitiveText(value, prohibitedStrings, path) {
  scanSecretOrProhibited(value, prohibitedStrings, path);
  if (isHttpUrl(value)) throw new TypeError(`${path} contains a URL outside a public-example URL Part`);
}

function scanSecretOrProhibited(value, prohibitedStrings, path) {
  if (prohibitedStrings.some((prohibited) => value.includes(prohibited))) throw new TypeError(`${path} contains a prohibited value`);
  if (SECRET_VALUE.test(value)) throw new TypeError(`${path} contains an authorization or secret value`);
}

function scanRawPayload(decoded, prohibitedHosts, prohibitedStrings, path) {
  try {
    const json = JSON.parse(decoded);
    scanPackage(json, prohibitedHosts, prohibitedStrings, `${path} JSON`);
    return;
  } catch (error) {
    if (error instanceof SyntaxError) {
      scanSensitiveText(decoded, prohibitedStrings, path);
      scanEmbeddedUrls(decoded, prohibitedHosts, path);
      scanAssociatedRawFields(decoded, prohibitedStrings, path);
      return;
    }
    throw error;
  }
}

function scanAssociatedRawFields(text, prohibitedStrings, path) {
  const matches = [
    ...text.matchAll(/(?:^|[&;\s<])([A-Za-z][A-Za-z0-9_-]{0,127})\s*=\s*([^&;\s>]+)/gu),
    ...text.matchAll(/<([A-Za-z][A-Za-z0-9_-]{0,127})[^>]*>([^<]{0,4096})<\/\1>/gu)
  ];
  for (const match of matches) {
    if (isForbiddenKey(match[1])) throw new TypeError(`${path} contains a forbidden field`);
    scanSensitiveText(safeDecode(match[2]), prohibitedStrings, `${path} field value`);
  }
  for (const line of text.split(/\r?\n/u)) {
    const match = line.match(/^\s*(?:-\s*)?["']?([A-Za-z][A-Za-z0-9_-]{0,127})["']?\s*:\s*(\S.*)$/u);
    if (!match || !isForbiddenKey(match[1])) continue;
    throw new TypeError(`${path} contains a forbidden field`);
  }
}

function scanEmbeddedUrls(value, prohibitedHosts, path) {
  for (const match of String(value).matchAll(/https?:\/\/[^\s<>'"`]+/giu)) {
    let url;
    try { url = new URL(match[0].replace(/[.,;:!?]+$/u, '')); } catch { continue; }
    if (prohibitedHosts.has(normalizeHost(url.hostname))) {
      throw new TypeError(`${path} contains a prohibited Agent endpoint, provider, or documentation host`);
    }
  }
}

function safeDecode(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function isRawPartPath(path) {
  return /^replicaPackage\.agentExamples\[\d+\]\.turns\[\d+\]\.input\.parts\[\d+\]\.raw$/u.test(path);
}

function isForbiddenKey(key) {
  const normalized = String(key).replaceAll(/[^A-Za-z0-9]/gu, '').toLowerCase();
  if (FORBIDDEN_KEY.test(normalized)) return true;
  if (CREDENTIAL_KEY_SUFFIX.test(normalized) && normalized !== 'tokencount') return true;
  return PLATFORM_SCORE_KEY.test(normalized);
}

function isPublicExampleUrlPath(path) {
  return /^replicaPackage\.agentExamples\[\d+\]\.turns\[\d+\]\.input\.parts\[\d+\]\.url$/u.test(path);
}

function collectSensitiveCardHosts(card) {
  const hosts = new Set();
  addUrlHost(card?.url, hosts);
  if (Array.isArray(card?.supportedInterfaces)) {
    for (const declaredInterface of card.supportedInterfaces) addUrlHost(declaredInterface?.url, hosts);
  }
  collectUrlHosts(card?.provider, hosts);
  for (const key of ['documentationUrl', 'documentationUrls', 'documentation', 'docs']) {
    collectUrlHosts(card?.[key], hosts);
  }
  return hosts;
}

function collectUrlHosts(value, hosts = new Set(), ancestors = new Set()) {
  if (!value || typeof value !== 'object') {
    addUrlHost(value, hosts);
    return hosts;
  }
  if (ancestors.has(value)) return hosts;
  const next = new Set(ancestors).add(value);
  for (const child of Object.values(value)) collectUrlHosts(child, hosts, next);
  return hosts;
}

function addUrlHost(value, hosts) {
  if (typeof value !== 'string' || !isHttpUrl(value)) return;
  try { hosts.add(normalizeHost(new URL(value).hostname)); } catch { /* validation occurs on public input paths */ }
}

function collectProhibitedHosts(values) {
  const hosts = new Set();
  const iterable = values instanceof Set ? values : Array.isArray(values) ? values : [values];
  for (const value of iterable) {
    if (typeof value !== 'string') continue;
    try { hosts.add(normalizeHost(new URL(value).hostname)); } catch { /* values can also be secrets */ }
  }
  return hosts;
}

function collectProhibitedStrings(values) {
  const iterable = values instanceof Set ? values : Array.isArray(values) ? values : [values];
  return [...iterable].filter((value) => typeof value === 'string' && value.length > 0);
}

function hasSecretLookingQuery(url) {
  return [...url.searchParams].some(([key, value]) =>
    SIGNED_QUERY_KEY.test(key) || SECRET_VALUE.test(safeDecode(key)) || SECRET_VALUE.test(safeDecode(value))
  );
}

function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\/\S+$/iu.test(value);
}

function normalizeHost(host) {
  return String(host).toLowerCase().replace(/^\[|\]$/gu, '');
}

function contentForHash(replicaPackage) {
  return {
    agent: replicaPackage.agent,
    agentExamples: replicaPackage.agentExamples,
    manifest: { ...replicaPackage.manifest, contentHash: undefined }
  };
}

function hashCanonical(value) {
  return createHash('sha256').update(JSON.stringify(canonicalClone(value, 'value')), 'utf8').digest('hex');
}

function canonicalClone(value, path, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must contain only JSON values`);
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError(`${path} must contain only JSON values`);
    const next = new Set(ancestors).add(value);
    return value.map((item, index) => canonicalClone(item, `${path}[${index}]`, next));
  }
  requireObject(value, path);
  if (ancestors.has(value)) throw new TypeError(`${path} must contain only JSON values`);
  const next = new Set(ancestors).add(value);
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) continue;
    Object.defineProperty(result, key, { value: canonicalClone(value[key], `${path}.${key}`, next), enumerable: true, writable: true, configurable: true });
  }
  return result;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

function assertStringArray(value, path) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new TypeError(`${path} must be a string array`);
}

function assertKeys(value, keys, path, optional = []) {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${path}.${key} is not an allowed Replica package field`);
  for (const key of keys) if (!optional.includes(key) && !Object.hasOwn(value, key)) throw new TypeError(`${path}.${key} is required`);
}

function requireObject(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${path} must be a plain object`);
  return value;
}

function requireString(value, path) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${path} must be a non-empty string`);
  return value;
}
