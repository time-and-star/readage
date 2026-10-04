import {
  closeSync,
  existsSync,
  openSync,
  readSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.dirname(fileURLToPath(import.meta.url));
const CEFR_LEVELS = new Set(["A1", "A2", "B1", "B2", "C1", "C2"]);
const CEFR_PRIORITY = { A1: 0, A2: 1, B1: 2, B2: 3, C1: 4, C2: 5 };
const PACK_FILE = "dictionary.pack";
const PACK_MAGIC = "NWDICT01";
const HEADER_LENGTH_BYTES = 4; // UInt32BE
const REQUIRED_FILES = [PACK_FILE];

export function normalizeWord(word) {
  return String(word ?? "").normalize("NFKC").toLowerCase().trim()
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u2010\u2011]/g, "-")
    .replace(/\u00ad/g, "")
    .replace(/^'+|'+$/g, "");
}

export function fallbackLemma(word) {
  const normalized = normalizeWord(word);
  if (normalized.endsWith("'s")) return normalized.slice(0, -2);
  if (normalized.length > 5 && normalized.endsWith("ies")) return `${normalized.slice(0, -3)}y`;
  if (normalized.length > 5 && normalized.endsWith("ied")) return `${normalized.slice(0, -3)}y`;

  if (normalized.length > 5 && normalized.endsWith("ing")) {
    const root = normalized.slice(0, -3);
    if (root.at(-1) && root.at(-1) === root.at(-2)) return root.slice(0, -1);
    return restoreSilentEStem(root);
  }

  if (normalized.length > 4 && normalized.endsWith("ed")) {
    const root = normalized.slice(0, -2);
    if (root.at(-1) && root.at(-1) === root.at(-2)) return root.slice(0, -1);
    if (root.endsWith("i") && root.length > 2) return `${root.slice(0, -1)}y`;
    if (/[aeiou]y$/.test(root) || /(ch|sh|ss|x)$/.test(root)) return root;
    return restoreSilentEStem(root);
  }

  if (normalized.length > 4 && /(ches|shes|xes|zes|ses)$/.test(normalized)) {
    return normalized.slice(0, -2);
  }

  if (normalized.length > 3 && normalized.endsWith("s")) {
    if (/(ss|us|ous|is|as|ns|ws|ys)$/.test(normalized)) return normalized;
    if (normalized.endsWith("ps") && /(?:haps|rhaps|lips|tips|caps|apps)$/.test(normalized)) {
      return normalized;
    }
    return normalized.slice(0, -1);
  }

  return normalized;
}

function restoreSilentEStem(stem) {
  if (!stem.endsWith("e") && stem.length >= 2 && !/[aeiou]$/.test(stem)) return `${stem}e`;
  return stem;
}

function buildCandidates(word) {
  const normalized = normalizeWord(word);
  const lemma = fallbackLemma(normalized);
  const candidates = [];
  const add = (value) => {
    const cleaned = normalizeWord(value);
    if (cleaned && !candidates.includes(cleaned)) candidates.push(cleaned);
  };

  add(lemma);
  if (!lemma.endsWith("e") && lemma.length >= 2 && !/[aeiou]$/.test(lemma)) add(`${lemma}e`);
  add(normalized);

  // Candidate generation is permissive; lookup validates every derived form
  // against the pack's exchange records before returning a different headword.
  if (normalized.endsWith("ing") && normalized.length > 4) {
    const root = normalized.slice(0, -3);
    add(root);
    add(`${root}e`);
    if (root.endsWith("y")) add(`${root.slice(0, -1)}ie`);
    if (root.at(-1) === root.at(-2)) add(root.slice(0, -1));
  }
  if (normalized.endsWith("s")) {
    add(normalized.slice(0, -1));
    if (normalized.endsWith("es")) add(normalized.slice(0, -2));
  }

  if (normalized.endsWith("ed") && normalized.length > 4) {
    const root = normalized.slice(0, -2);
    if (root.endsWith("i") && root.length > 2) add(`${root.slice(0, -1)}y`);
    if (root.at(-1) && root.at(-1) === root.at(-2)) add(root.slice(0, -1));
  }

  return candidates;
}

export function createDictionary(options = {}) {
  const dataDir = path.resolve(options.dataDir ?? path.join(packageDir, "data"));
  const packPath = path.join(dataDir, PACK_FILE);
  const entryCache = new Map();
  const indexShardCache = new Map();
  const enhancedShardCache = new Map();
  let packHeader;
  let headerIndexes;
  let cefrMap;
  let wordFamilies;

  function getHealth() {
    const missingRequired = REQUIRED_FILES.filter((file) => !existsSync(path.join(dataDir, file)));
    const missingOptional = [];
    let indexedEntries = 0;
    let sourceRows = 0;
    let csvBytes = 0;

    if (missingRequired.length === 0) {
      try {
        const { header, sections } = getPackHeader();
        indexedEntries = Number(header.indexedWords ?? 0);
        sourceRows = Number(header.sourceRows ?? 0);
        csvBytes = sections.get("records")?.length ?? 0;

        const sectionNames = [...sections.keys()];
        if (!sections.has("records") || !sectionNames.some((name) => name.startsWith("index."))) {
          missingRequired.push(`${PACK_FILE} (missing index/records sections)`);
        }
        if (!sectionNames.some((name) => name.startsWith("enhanced."))) {
          missingOptional.push("section:enhanced.*");
        }
        if (!sections.has("cefr")) missingOptional.push("section:cefr");
        if (!sections.has("families")) missingOptional.push("section:families");
      } catch (error) {
        missingRequired.push(`${PACK_FILE} (invalid: ${error.message})`);
      }
    }

    return {
      ok: missingRequired.length === 0,
      dataDir,
      indexedEntries,
      sourceRows,
      csvBytes,
      missingRequired,
      missingOptional,
    };
  }

  function getPackHeader() {
    if (packHeader) return packHeader;
    const fd = openSync(packPath, "r");
    try {
      const fixed = Buffer.alloc(PACK_MAGIC.length + HEADER_LENGTH_BYTES);
      if (readSync(fd, fixed, 0, fixed.length, 0) !== fixed.length) {
        throw new Error("truncated fixed header");
      }
      if (fixed.subarray(0, PACK_MAGIC.length).toString("ascii") !== PACK_MAGIC) {
        throw new Error("bad magic");
      }
      const headerLength = fixed.readUInt32BE(PACK_MAGIC.length);
      const headerBuffer = Buffer.alloc(headerLength);
      if (readSync(fd, headerBuffer, 0, headerLength, fixed.length) !== headerLength) {
        throw new Error("truncated header JSON");
      }
      const header = JSON.parse(headerBuffer.toString("utf8"));
      if (!Array.isArray(header.sections)) throw new Error("missing sections table");
      const sections = new Map(
        header.sections.map((section) => [section.name, { offset: section.offset, length: section.length }]),
      );
      packHeader = { header, sections };
      return packHeader;
    } finally {
      closeSync(fd);
    }
  }

  function readSection(name) {
    const { sections } = getPackHeader();
    const section = sections.get(name);
    if (!section) return null;
    const fd = openSync(packPath, "r");
    const buffer = Buffer.alloc(section.length);
    try {
      const bytesRead = readSync(fd, buffer, 0, section.length, section.offset);
      return buffer.subarray(0, bytesRead);
    } finally {
      closeSync(fd);
    }
  }

  function readJsonSection(name) {
    const buffer = readSection(name);
    return buffer ? JSON.parse(buffer.toString("utf8")) : null;
  }

  function getShardKey(word) {
    return /^[a-z]$/.test(word[0] ?? "") ? word[0] : "_";
  }

  function getIndexShard(shardKey) {
    if (indexShardCache.has(shardKey)) return indexShardCache.get(shardKey);
    const shard = readJsonSection(`index.${shardKey}`);
    indexShardCache.set(shardKey, shard);
    return shard;
  }

  function getEnhancedShard(shardKey) {
    if (enhancedShardCache.has(shardKey)) return enhancedShardCache.get(shardKey);
    const shard = readJsonSection(`enhanced.${shardKey}`);
    enhancedShardCache.set(shardKey, shard);
    return shard;
  }

  function getEnhanced(word) {
    return getEnhancedShard(getShardKey(word))?.[word] ?? null;
  }

  function getCefrMap() {
    if (cefrMap) return cefrMap;
    cefrMap = new Map();
    const raw = readJsonSection("cefr");
    if (raw) {
      for (const [word, level] of Object.entries(raw)) {
        if (CEFR_LEVELS.has(level)) cefrMap.set(word, level);
      }
    }
    return cefrMap;
  }

  function getHeaderIndexes() {
    if (headerIndexes) return headerIndexes;
    const header = parseCsvLine(getPackHeader().header.sourceCsvHeader ?? "");
    headerIndexes = {
      word: header.indexOf("word"),
      phonetic: header.indexOf("phonetic"),
      definition: header.indexOf("definition"),
      translation: header.indexOf("translation"),
      pos: header.indexOf("pos"),
      tag: header.indexOf("tag"),
      exchange: header.indexOf("exchange"),
    };
    if (Object.values(headerIndexes).some((index) => index < 0)) {
      throw new Error("The ECDICT CSV header is missing one or more required columns.");
    }
    return headerIndexes;
  }

  function readLocalEntry(word) {
    const shard = getIndexShard(getShardKey(word));
    const indexEntry = shard?.[word];
    if (!Array.isArray(indexEntry) || indexEntry.length < 2) return null;

    const { sections } = getPackHeader();
    const records = sections.get("records");
    if (!records) throw new Error("Invalid dictionary pack: missing records section.");
    const [relativeOffset, length] = indexEntry;
    if (
      !Number.isSafeInteger(relativeOffset) ||
      !Number.isSafeInteger(length) ||
      relativeOffset < 0 ||
      length <= 0 ||
      length > 1024 * 1024 ||
      relativeOffset + length > records.length
    ) {
      throw new Error(`Invalid pack index entry for "${word}".`);
    }
    const fd = openSync(packPath, "r");
    const buffer = Buffer.alloc(length);
    try {
      const bytesRead = readSync(fd, buffer, 0, length, records.offset + relativeOffset);
      const record = parseCsvLine(buffer.subarray(0, bytesRead).toString("utf8").replace(/\r?\n$/, ""));
      const indexes = getHeaderIndexes();
      return {
        word: normalizeWord(record[indexes.word] ?? ""),
        phonetic: record[indexes.phonetic] ?? "",
        definition: record[indexes.definition] ?? "",
        translation: record[indexes.translation] ?? "",
        pos: record[indexes.pos] ?? "",
        tag: record[indexes.tag] ?? "",
        exchange: record[indexes.exchange] ?? "",
      };
    } finally {
      closeSync(fd);
    }
  }

  function loadWordFamilies() {
    if (wordFamilies) return wordFamilies;
    wordFamilies = new Map();
    const buffer = readSection("families");
    if (!buffer) return wordFamilies;

    for (const line of buffer.toString("utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      let item;
      try {
        item = JSON.parse(line);
      } catch {
        continue;
      }
      if (!Array.isArray(item.words)) continue;
      const family = item.words.map(normalizeWord).filter(Boolean);
      const strong = item.category === "derivation" || item.category === "root";
      for (const member of family) {
        const current = wordFamilies.get(member) ?? { strong: [], weak: [] };
        const target = strong ? current.strong : current.weak;
        for (const related of family) {
          if (related !== member && !target.includes(related)) target.push(related);
        }
        wordFamilies.set(member, current);
      }
      if (item.root) {
        for (const root of String(item.root).split("/").map(normalizeWord).filter(Boolean)) {
          if (!wordFamilies.has(root)) wordFamilies.set(root, { strong: [...family], weak: [] });
        }
      }
    }

    return wordFamilies;
  }

  function getRelatedWords(word) {
    const families = loadWordFamilies();
    const normalized = normalizeWord(word);
    const family = families.get(normalized) ?? families.get(fallbackLemma(normalized));
    if (!family) return [];

    const seen = new Set();
    const candidates = [];
    for (const related of family.strong) {
      if (!seen.has(related)) {
        seen.add(related);
        candidates.push({ word: related, strong: true });
      }
    }
    let weakCount = 0;
    for (const related of family.weak) {
      if (!seen.has(related) && weakCount < 4) {
        seen.add(related);
        weakCount += 1;
        candidates.push({ word: related, strong: false });
      }
    }

    const levels = getCefrMap();
    return candidates
      .filter(({ word: related }) => levels.size === 0 || levels.has(related))
      .sort((a, b) => {
        if (a.strong !== b.strong) return a.strong ? -1 : 1;
        return (CEFR_PRIORITY[levels.get(a.word)] ?? 6) - (CEFR_PRIORITY[levels.get(b.word)] ?? 6);
      })
      .slice(0, 12)
      .map(({ word: related }) => related);
  }

  function buildEntry(query, local) {
    const headword = local.word;
    const translations = parseTranslationGroups(local.translation);
    const localDefinitions = parseDefinitions(local.definition);
    const enhanced = getEnhanced(headword);
    const enhancedDefinitions = Array.isArray(enhanced?.definitions) ? enhanced.definitions : [];
    const hasZhDefinitions =
      enhancedDefinitions.some((definition) => definition.src === "zh") ||
      Array.isArray(enhanced?.zhDefinitions);

    // definitions were merged at build time (manual first, zh fallback);
    // without zh entries the CSV definitions join as the fallback base.
    const enhancedAsEnglish = enhancedDefinitions.map((definition) => ({
      partOfSpeech: definition.pos ?? "",
      definition: definition.en ?? "",
      definitionZh: definition.zh ?? "",
    }));
    const definitionsEn = hasZhDefinitions
      ? enhancedAsEnglish
      : mergeDefinitions(localDefinitions, enhancedAsEnglish);

    const zhSource = Array.isArray(enhanced?.zhDefinitions)
      ? enhanced.zhDefinitions
      : enhancedDefinitions.filter((definition) => definition.src === "zh");
    const definitionsZhBase = hasZhDefinitions
      ? zhSource.map((definition) => ({
          partOfSpeech: definition.pos ?? "",
          definitionEn: definition.en ?? "",
          definitionZh: definition.zh ?? "",
        }))
      : localDefinitions
          .map((definition, index) => ({
            partOfSpeech: definition.partOfSpeech || translations[index]?.partOfSpeech || "",
            definitionEn: definition.definition,
            definitionZh: translations[index]?.meanings?.join("；") ?? "",
          }))
          .filter((definition) => definition.definitionZh);

    const optimized = enhanced?.optimized;
    const optimizedMeanings = Array.isArray(optimized?.meanings)
      ? optimized.meanings.map((item) => String(item.zh ?? "").trim()).filter(Boolean)
      : [];
    const phonetic = formatPhonetic(local.phonetic);
    const partOfSpeech =
      local.pos || translations[0]?.partOfSpeech || definitionsEn[0]?.partOfSpeech || "unknown";

    return {
      query,
      lemma: headword,
      phonetic,
      phonetics: phonetic ? [{ label: "音", text: phonetic }] : [],
      cefrLevel: getCefrMap().get(headword) ?? null,
      partOfSpeech,
      basicMeaningsZh: optimizedMeanings.length ? optimizedMeanings : flattenTranslations(translations),
      dictionaryTranslations: optimizedMeanings.length
        ? [{ partOfSpeech, meanings: optimizedMeanings }]
        : translations,
      definitionEn: definitionsEn[0]?.definition ?? "",
      definitionsEn,
      definitionsZh: optimizedMeanings.length
        ? optimizedMeanings.map((definitionZh) => ({ partOfSpeech, definitionEn: "", definitionZh }))
        : definitionsZhBase,
      exchanges: parseExchanges(local.exchange),
      relatedWords: Array.isArray(optimized?.related) && optimized.related.length
        ? optimized.related.map(normalizeWord).filter(Boolean)
        : getRelatedWords(headword),
      tags: parseTags(local.tag),
      collocations: Array.isArray(optimized?.collocations) ? optimized.collocations : [],
      usageNotes: String(optimized?.usageNotes ?? ""),
      register: String(optimized?.register ?? ""),
      source: "ECDICT",
    };
  }

  async function lookupExact(word) {
    const normalized = normalizeWord(word);
    if (!normalized) return null;
    const cacheKey = `exact:${normalized}`;
    if (entryCache.has(cacheKey)) return entryCache.get(cacheKey);
    const local = readLocalEntry(normalized);
    const entry = local ? buildEntry(normalized, local) : null;
    entryCache.set(cacheKey, entry);
    return entry;
  }

  async function lookup(word) {
    const query = normalizeWord(word);
    if (!query) return null;
    const cacheKey = `lookup:${query}`;
    if (entryCache.has(cacheKey)) return entryCache.get(cacheKey);

    const exact = readLocalEntry(query);
    const exactForms = parseExchanges(exact?.exchange ?? "");
    // Contractions/compounds must not be stemmed into unrelated words or phrases.
    const candidates = /['\s-]/.test(query) ? [query] : buildCandidates(query);
    for (const candidate of candidates) {
      const local = readLocalEntry(candidate);
      if (local) {
        if (candidate !== query) {
          const forms = parseExchanges(local.exchange);
          const confirmed = exactForms.some((form) => form.label === "原形" && normalizeWord(form.value) === candidate)
            || forms.some((form) => form.label !== "原形" && normalizeWord(form.value) === query);
          if (!confirmed) continue;
        }
        const entry = buildEntry(query, local);
        entryCache.set(cacheKey, entry);
        return entry;
      }
    }

    entryCache.set(cacheKey, null);
    return null;
  }

  async function lookupMany(words) {
    return Promise.all(Array.from(words ?? [], (word) => lookup(word)));
  }

  function clearCaches() {
    entryCache.clear();
    indexShardCache.clear();
    enhancedShardCache.clear();
    packHeader = undefined;
    headerIndexes = undefined;
    cefrMap = undefined;
    wordFamilies = undefined;
  }

  return { dataDir, getHealth, lookup, lookupExact, lookupMany, clearCaches };
}

let defaultDictionary;
function getDefaultDictionary() {
  defaultDictionary ??= createDictionary();
  return defaultDictionary;
}

export function getHealth() {
  return getDefaultDictionary().getHealth();
}

export function lookup(word) {
  return getDefaultDictionary().lookup(word);
}

export function lookupExact(word) {
  return getDefaultDictionary().lookupExact(word);
}

export function lookupMany(words) {
  return getDefaultDictionary().lookupMany(words);
}

function parseCsvLine(raw) {
  const row = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === '"' && quoted && raw[index + 1] === '"') {
      value += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(value);
      value = "";
    } else {
      value += char;
    }
  }
  row.push(value);
  return row;
}

function parseTranslationGroups(translation) {
  if (!translation) return [];
  return translation
    .split(/\\n|[;\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const match = item.match(/^([a-z.]+)\s*(.+)$/i);
      return match
        ? { partOfSpeech: normalizePartOfSpeech(match[1]), meanings: splitMeanings(match[2]) }
        : { partOfSpeech: "", meanings: splitMeanings(item) };
    })
    .filter((group) => group.meanings.length)
    .slice(0, 8);
}

function flattenTranslations(groups) {
  return groups.slice(0, 6).map((group) => `${group.partOfSpeech ? `${group.partOfSpeech} ` : ""}${group.meanings.join("；")}`);
}

function splitMeanings(value) {
  return value.split(/[,，;；]/).map((item) => item.trim()).filter(Boolean).slice(0, 8);
}

function parseDefinitions(definition) {
  if (!definition) return [];
  const definitions = [];
  for (const rawLine of definition.split(/\\n|\r?\n/)) {
    const line = cleanDefinition(rawLine);
    if (!line) continue;
    const match = line.match(/^((?:n|v|vi|vt|a|s|r|adj|adv|prep|pron|conj|int|interj)\.?)\s+(.+)$/i);
    if (match) {
      definitions.push({ partOfSpeech: normalizePartOfSpeech(match[1]), definition: cleanDefinition(match[2]) });
    } else if (definitions.length) {
      definitions.at(-1).definition = cleanDefinition(`${definitions.at(-1).definition} ${line}`);
    } else {
      definitions.push({ partOfSpeech: "", definition: line });
    }
  }
  return definitions;
}

function mergeDefinitions(base, manual) {
  const seen = new Set();
  const merged = [];
  for (const definition of [...manual, ...base]) {
    const key = cleanDefinition(definition.definition).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(definition);
  }
  return merged;
}

function cleanDefinition(value) {
  return String(value ?? "").replace(/\\n/g, " ").replace(/\s+/g, " ").trim();
}

function normalizePartOfSpeech(value) {
  const normalized = String(value ?? "").replace(/\.$/, "").toLowerCase();
  return ({ a: "adj.", s: "adj.", r: "adv.", n: "n.", v: "v.", vi: "vi.", vt: "vt.", adj: "adj.", adv: "adv.", prep: "prep.", pron: "pron.", conj: "conj.", int: "int.", interj: "interj." })[normalized] ?? (normalized ? `${normalized}.` : "");
}

function parseExchanges(exchange) {
  if (!exchange) return [];
  const labels = { p: "过去式", d: "过去分词", i: "现在分词", 3: "第三人称单数", r: "比较级", t: "最高级", s: "复数", 0: "原形", 1: "第三人称单数" };
  return exchange.split("/").map((item) => {
    const separator = item.indexOf(":");
    const key = separator >= 0 ? item.slice(0, separator) : item;
    const value = separator >= 0 ? item.slice(separator + 1) : "";
    return { label: labels[key] ?? key, value };
  }).filter((item) => item.label && item.value).slice(0, 8);
}

function parseTags(tag) {
  if (!tag) return [];
  const labels = { zk: "中考", gk: "高考", cet4: "CET4", cet6: "CET6", ky: "考研", toefl: "TOEFL", ielts: "IELTS", gre: "GRE", bzk: "商务英语" };
  return tag.split(/\s+/).map((item) => labels[item] ?? item.toUpperCase()).filter(Boolean).slice(0, 8);
}

function formatPhonetic(phonetic) {
  const trimmed = String(phonetic ?? "").trim();
  return trimmed ? `/${trimmed.replace(/^\/|\/$/g, "")}/` : "";
}

// Internal helpers shared with scripts/build-pack.mjs so the build-time
// normalization rules can never drift from the runtime rules.
export { cleanDefinition, normalizePartOfSpeech };
