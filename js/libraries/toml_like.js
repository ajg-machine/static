"use strict";


const DELIMITERS = "=\n;,()[]{}#";


class ConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = this.constructor.name;
        Error.captureStackTrace(this, this.constructor);
    }
    toString() {
        return `configuration error: ${this.message}`;
    }
}


function* generateFrom(value) {
    if (isString(value)) {
        yield* value;
    } else {
        let decoder = new TextDecoder("utf-8");
        yield* decoder.decode(value);
    }
}


function* generateFromChunks(chunks) {
    let decoder = null;
    for (let chunk of chunks) {
        if (decoder !== false) {
            if (decoder === null) {
                if (isString(chunk)) {
                    decoder === false;
                } else {
                    decoder = new TextDecoder("utf-8");
                    chunk = decoder.decode(chunk, {stream: true});
                }
            } else {
                chunk = decoder.decode(chunk, {stream: true});
            }
        }
        yield* chunk;
    }
    if (decoder !== null && decoder !== false) {
        yield* decoder.decode();
    }
}


async function accumulateStreamChunks(stream) {
    let chunks = [];
    for await (let chunk of stream) {
        chunks.push(chunk);
    }
    return chunks;
}


function iterOverMap(input) {
    if (input instanceof Map) {
        return input.entries();
    } else if (typeof input === "object" && !Array.isArray(input) && input !== null) {
        return Object.entries(input);
    } else {
        throw new ConfigError(`input ${formatRepr(input)} has invalid type (map or js object expected)`);
    }
}


function isString(value) {
    if (typeof value === "string") return true;
    if (value instanceof String) return true;
    return false;
}


function isNumber(value) {
    if (typeof value === "number") return true;
    if (typeof value === "bigint") return true;
    if (value instanceof Number) return true;
    if (value instanceof BigInt) return true;
    return false;
}


function isArrayLike(value) {
    if (Array.isArray(value)) return true;
    if (ArrayBuffer.isView(value)) return true;
    if (value instanceof ArrayBuffer) return true;
    if (value instanceof Set) return true;
    return false;
}


function formatRepr(value) {
    let type = typeof value;
    if (type === "object") type = value.constructor.name;
    let string = isString(value);
    value = string ? `"${value.replace(/"/g, '\\"')}"` : `${value}`;
    for (let code of ["\\", "r", "n", "t", "f", "v"]) {
        let regex = new RegExp(`\\${code}`, "g");
        value = value.replace(regex, `\\${code}`);
    }
    let length = value.length;
    if (length > 80) value = `${value.slice(0, 70)} [+${length - 70}]`;
    if (!string) value = `${value} [${type}]`;
    return value;
}


function matchUntil(characters, delimiters, allowEnd=false) {
    let result = [];
    let isEscaped = false;
    let character = characters.next();
    while (!character.done) {
        character = character.value;
        if (isEscaped) {
            result.push(character);
            isEscaped = false;
        } else if (character === "\\") {
            isEscaped = true;
        } else if (delimiters.includes(character)) {
            return [result.join(""), character];
        } else {
            result.push(character);
        }
        character = characters.next();
    }
    if (allowEnd) return [result.join(""), ""];
    throw new ConfigError("unexpected end of input (delimiter expected)");
}


function matchNext(characters, allowEnd=false) {
    let character = characters.next();
    while (!character.done) {
        character = character.value;
        if (!character.match(/\s/)) return character;
        character = characters.next();
    }
    if (!allowEnd) throw new ConfigError("unexpected end of input");
}


function matchEntries(characters) {
    let result = new Map();
    let target = result;
    while (true) {
        let key = matchUntil(characters, DELIMITERS, true);
        key[0] = key[0].trim();
        if (!key[1]) {
            if (key[0]) throw new ConfigError(`input ${formatRepr(key[0])} unexpected`);
            break;
        } else if (key[1] === "\n" && !key[0]) {
            continue;
        } else if (key[1] === "#" && !key[0]) {
            matchUntil(characters, "\n", true);
            continue;
        } else if (key[1] === "[") {
            if (key[0]) throw new ConfigError(`input ${formatRepr(key[0])} unexpected`);
            key = matchUntil(characters, DELIMITERS, true);
            key[0] = key[0].trim()
            if (key[1] !== "]") {
                throw new ConfigError(`special character ${formatRepr(key[1])} unexpected at key starting with ${formatRepr(key[0])}`);
            }
            target = new Map();
            result.set(key[0], target);
            continue;
        } else if (key[1] !== "=") {
            throw new ConfigError(`special character ${formatRepr(key[1])} unexpected at key starting with ${formatRepr(key[0])}`);
        }
        let value = matchValue(characters)
        if (!value[1]) {
            let over = matchUntil(characters, DELIMITERS, true);
            over[0] = over[0].trim();
            if (over[0]) throw new ConfigError(`input ${formatRepr(over[0])} unexpected at key ${formatRepr(key[0])}`);
            value[1] = over[1];
        }
        if (value[1] === "#") {
            matchUntil(characters, "\n", true);
        } else if (value[1] && !"\n;".includes(value[1])) {
            throw new ConfigError(`special character ${formatRepr(value[1])} unexpected at key ${formatRepr(key[0])}`);
        }
        target.set(key[0], value[0]);
    }
    return result;
}


function matchValue(characters, allowEndOfArray=false, isKey=false) {
    let start = matchNext(characters);
    if (allowEndOfArray && start.match(/[\]\)\}]/)) {
        return [null, start, "END_OF_ITERABLE"];
    } else if (isKey) {
        return matchKey(characters, start);
    } else if (start.match(/['"]/)) {
        return matchString(characters, start);
    } else if (start.match(/[0-9.+-]/)) {
        return matchNumber(characters, start);
    } else if (start.match(/[a-z_]/i)) {
        return matchKeyword(characters, start);
    } else if (start.match(/[\[\(]/)) {
        return matchArray(characters, start);
    } else if (start.match(/[\{]/)) {
        return matchMap(characters);
    } else {
        throw new ConfigError(`unable to infer type of element starting with ${formatRepr(start)}`);
    }
}


function matchKey(characters, start) {
    let result = matchUntil(characters, DELIMITERS, true);
    result[0] = `${start}${result[0]}`.trim();
    if (!result[0].length) throw new ConfigError("key missing");
    return [result[0], result[1], "KEY"];
}


function matchString(characters, delimiter) {
    let result = matchUntil(characters, delimiter);
    return [result[0], "", "STRING"];
}


function matchNumber(characters, start) {
    let [result, end] = matchUntil(characters, DELIMITERS, true);
    let sign = start === "-" ? -1 : 1;
    if (start !== "-" && start !== "+") result = `${start}${result}`;
    if (result.search(/[-/]/) > -1) return matchDate(result, end);
    result = result.replace(/_/g, "").replace(/ /g, "").toLowerCase();
    if (result.match(/^(na|nan)$/)) return [sign * NaN, end, "NUMBER"];
    if (result.match(/^(inf|infinity)$/)) return [sign * Infinity, end, "NUMBER"];
    let number = Number(result);
    if (Number.isNaN(number)) throw new ConfigError(`number ${formatRepr(result)} invalid`);
    return [sign * number, end, "NUMBER"];
}


function matchDate(raw, end) {
    let datePattern = "((?:\\d{4}-\\d{2}-\\d{2}|\\d{4}/\\d{2}/\\d{2}))";
    let timePatterm = "(\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?)";
    let offsetPattern = "(?:UTC)? *([+-] *(?:\\d{2}:\\d{2}|\\d{1,2}))";
    let pattern = `^${datePattern}((?:T| *)${timePatterm}?)? *${offsetPattern}?$`;
    let regex = new RegExp(pattern, "i");
    let match = raw.match(regex);
    if (!match) throw new ConfigError(`date ${formatRepr(raw)} invalid`);
    let [, date, , time, , fractional, offset] = match;
    let [year, month, day] = date.split(/[-/]/g).map(Number);
    let [h = 0, min = 0, s = 0] = (time || "00:00:00").split(":").map(Number);
    let ms = Number(`0${(fractional || ".0")}`) * 1000;
    let dateObject = new Date(year, month - 1, day, h, min, s, ms);
    if (offset) {
        let [hOffset, minOffset] = offset.slice(1).split(":").map(Number);
        let msOffset = (hOffset * 60 + (minOffset || 0)) * 60 * 1000;
        if (offset[0] === "-") msOffset = -msOffset;
        dateObject = new Date(Date.UTC(year, month - 1, day, h, min, s, ms));
        dateObject.setTime(dateObject.getTime() - msOffset);
    }
    return [dateObject, end, "DATE"];
}


function matchKeyword(characters, start) {
    let [result, end] = matchUntil(characters, DELIMITERS, true);
    result = `${start}${result}`.trim().toLowerCase();
    let keyword = {
        "true": true, "false": false, "null": null,
        "inf": Infinity, "infinity": Infinity,
        "na": NaN, "nan": NaN,
    }[result];
    if (keyword === undefined) throw new ConfigError(`keyword ${formatRepr(result)} invalid`);
    return [keyword, end, "KEYWORD"];
}


function matchArray(characters, start) {
    let result = [];
    let entry = [null, ",", null];
    while (entry[1] === ",") {
        entry = matchValue(characters, true);
        if (!entry[1]) entry[1] = matchNext(characters);
        if (entry[2] === "END_OF_ITERABLE") {
            let delimiter = {"[": "]", "(": ")"}[start];
            if (entry[1] !== delimiter) {
                let info = `${formatRepr(delimiter)} expected but ${formatRepr(entry[1])} found`;
                throw new ConfigError(`end of array delimiter ${info}`);
            }
        } else {
            result.push(entry[0]);
        }
    }
    return [result, "", "ARRAY"];
}


function matchMap(characters) {
    let result = new Map();
    let entry = [null, ",", null];
    while (entry[1] === ",") {
        let entryKey = matchValue(characters, true, true);
        if (!entryKey[1]) entryKey[1] = matchNext(characters, true);
        if (entryKey[2] === "END_OF_ITERABLE") {
            if (entryKey[1] !== "}") {
                let info = `${formatRepr("}")} expected but ${formatRepr(entryKey[1])} found`;
                throw new ConfigError(`end of map delimiter ${info}`);
            }
            break;
        } else if (entryKey[1] !== "=") {
            throw new ConfigError(`delimiter "=" missing`);
        }
        entry = matchValue(characters, true);
        if (!entry[1]) entry[1] = matchNext(characters, true);
        if (entry[2] === "END_OF_ITERABLE") {
            if (entry[1] !== "}") {
                let info = `${formatRepr("}")} expected but ${formatRepr(entryKey[1])} found`;
                throw new ConfigError(`end of map delimiter ${info}`);
            }
        } else {
            result.set(entryKey[0], entry[0]);
        }
    }
    return [result, "", "MAP"];
}


function decode(input) {
    if (isString(input)) {
        return matchEntries(generateFrom(input));
    } else if (input != null && typeof input[Symbol.iterator] === "function") {
        return matchEntries(generateFromChunks(input));
    } else if (input instanceof ReadableStream) {
        return accumulateStreamChunks(input)
            .then(chunks => matchEntries(generateFromChunks(chunks)));
    } else if (input instanceof Blob) {
        return accumulateStreamChunks(input.stream())
            .then(chunks => matchEntries(generateFromChunks(chunks)));
    } else {
        throw new ConfigError(`input ${formatRepr(input)} has unimplemented type`);
    }
}


function encodeValue(input, references, level, levelUpIfNotMap=true) {
    if (isString(input)) {
        return ["STRING", encodeString(input)];
    } else if (isNumber(input)) {
        return ["NUMBER", encodeNumber(input)];
    } else if (input instanceof Date) {
        return ["DATE", encodeDate(input)];
    } else if ([undefined, null, true, false].includes(input)) {
        if (input === undefined) input = null;
        return ["KEYWORD", [`${input}`.toUpperCase()]];
    } else if (isArrayLike(input)) {
        if (input instanceof DataView) input = new Uint8Array(input.buffer);
        if (input instanceof ArrayBuffer) input = new Uint8Array(input);
        level += levelUpIfNotMap ? 1 : 0;
        return ["ARRAY", encodeArray(input, references, level)];
    } else if (input instanceof Map || typeof input === "object") {
        return ["MAP", encodeMap(input, references, level + 1)];
    } else {
        throw new ConfigError(`input ${formatRepr(input)} has unimplemented type`);
    }
}


function encodeString(input) {
    return ['"' + input.replace(/"/g, '\\"') + '"'];
} 


function encodeNumber(input) {
    if (input instanceof BigInt || Number.isFinite(input)) {
        return [`${input}`];
    } else {
        return [`${input}`.toUpperCase()];
    }
}


function encodeDate(input) {
    let pad = (num, size) => num.toString().padStart(size, "0");
    let year = input.getUTCFullYear();
    let month = pad(input.getUTCMonth() + 1, 2); // Months are zero-based
    let day = pad(input.getUTCDate(), 2);
    let h = pad(input.getUTCHours(), 2);
    let min = pad(input.getUTCMinutes(), 2);
    let s = pad(input.getUTCSeconds(), 2);
    let ms = pad(input.getUTCMilliseconds(), 3);
    let localDate = `${year}-${month}-${day}`;
    let localTime = ms === "000"
        ? `${h}:${min}:${s}`
        : `${h}:${min}:${s}.${ms}`;
    let localDateTime = `${localDate} ${localTime}`;
    let minOffset = -input.getTimezoneOffset();
    let hOffset = pad(Math.floor(Math.abs(minOffset) / 60), 2);
    let offsetSign = minOffset >= 0 ? "+" : "-";
    minOffset = pad(Math.abs(minOffset) % 60, 2);
    let offset = minOffset === "00"
        ? `${offsetSign}${hOffset[0] === "0" ? hOffset[1] : hOffset}`
        : `${offsetSign}${hOffset}:${minOffset}`;
    return [`${localDateTime} UTC${offset}`];
}


function encodeArray(input, references, level) {
    if (references.has(input)) throw new ConfigError(`circular reference to ${formatRepr(input)}`);
    references.add(input);
    let result = Array.from(input, entry => {
        return encodeValue(entry, references, level)[1];
    });
    let length = result.reduce((sum, entry) => {
        return sum + entry.reduce((sum, x) => sum + x.length, 0) + 2;
    }, 0);
    if (length === 0) {
        result = ["[]"];
    } else if (level === 1 && length > 80) {
        result = result.map(entry => ["    ", ...entry, ",\n"]);
        result = ["[\n", ...result.flat(), "]"];
    } else {
        result = result.map(entry => [...entry, ", "]);
        result[result.length - 1].pop();
        result = ["[", ...result.flat(), "]"];
    }
    references.delete(input);
    return result;
}


function checkKey(key) {
    if (!isString(key)) {
        throw new ConfigError(`key ${formatRepr(key)} has invalid type (string expected)`);
    }
    key = key.trim();
    if (key.search(/[^a-z0-9_-]/i) > -1) {
        let allowed = "(only letters, digits, _ and - allowed)";
        throw new ConfigError(`key ${formatRepr(key)} contains an invalid character ${allowed}`);
    }
    return key;
}


function encodeMap(input, references, level) {
    if (references.has(input)) throw new ConfigError(`circular reference to ${formatRepr(input)}`);
    references.add(input);
    let result;
    if (level <= 1) {
        result = Array.from(iterOverMap(input), (entry, i) => {
            let [key, value] = entry;
            key = checkKey(key);
            let valueType;
            [valueType, value] = encodeValue(value, references, level, level !== 1);
            if (level === 0 && valueType === "MAP") {
                key = i ? `\n[${key}]\n` : `[${key}]\n`;
                if (value.length) return [key, ...value, "\n"];
                return [key];
            } else {
                return [key, " = ", ...value, "\n"];
            }
        });
        if (result.length) result[result.length - 1].pop();
        result = result.flat();
    } else {
        result = Array.from(iterOverMap(input), entry => {
            let [key, value] = entry;
            key = checkKey(key);
            value = encodeValue(value, references, level)[1];
            return [key, value];
        });
        let length = result.reduce((sum, entry) => {
            let keyLength = entry[0].length;
            let valueLength = entry[1].reduce((sum, x) => sum + x.length, 0);
            return sum + keyLength + valueLength + 5;
        }, 0);
        if (length === 0) {
            result = ["{}"];
        } else if (level === 2 && length > 80) {
            result = result.map(entry => ["    ", ...entry[0], " = ", ...entry[1], ",\n"]);
            result = ["{\n", ...result.flat(), "}"];
        } else {
            result = result.map(entry => [...entry[0], " = ", ...entry[1], ", "]);
            result[result.length - 1].pop();
            result = ["{ ", ...result.flat(), " }"];
        }
    }
    references.delete(input);
    return result;
}


function encode(input) {
    return encodeMap(input, new WeakSet(), 0).join("");
}
