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
        throw new ConfigError(`input ${repr(input)} has invalid type (map or js object expected)`);
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


function repr(value, {maxLength=60}={}) {
    let type = typeof value;
    if (type === "object") type = value.constructor.name;
    let string = isString(value);
    value = string ? `«\u202F${value}\u202F»` : `${value}`;
    for (let code of ["\\", "r", "n", "t", "f", "v"]) {
        let regex = new RegExp(`\\${code}`, "g");
        value = value.replace(regex, `\\${code}`);
    }
    let over = value.length - maxLength;
    if (over > 0) value = `${value.slice(0, maxLength)} [+${over}]`;
    if (!string) value = `${value} [${type}]`;
    return value;
}


function matchUntil(characters, delimiters, {endOfInput=false}={}) {
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
            result = result.join("");
            return [result, character];
        } else {
            result.push(character);
        }
        character = characters.next();
    }
    result = result.join("");
    if (!endOfInput) {
        result = result.trim();
        result = result ? ` (from ${repr(result, {maxLength: 20})})` : "";
        throw new ConfigError(`unexpected end of input${result}`);
    }
    return [result, ""];
}


function checkMatch(expected, character, type) {
    if (expected.includes(type)) return;
    expected = expected.length > 1
        ? `${expected.slice(0, -1).join(", ")} or ${expected.slice(-1)[0]}`
        : `${expected}`;
    expected = expected.replace(/_/g, " ").toLowerCase();
    type = type.replace(/_/g, " ").toLowerCase();
    let message = character === ""
        ? `${type} reached`
        : `${type} ${repr(character)} reached`;
    throw new ConfigError(`${message} but ${expected} expected`);
}


function matchNext(characters, {expected=[], entryKey, start, newLine}={}) {
    // KEY VALUE LIST_DIVIDER LIST_END LINE_END INPUT_END
    start = start ? {value: start, done: false} : characters.next();
    while (!start.done) {
        start = start.value;
        if (start.match(/[\n#]/)) {
            checkMatch(expected, start, "LINE_END");
            if (start.match(/[#]/)) {
                matchUntil(characters, "\n", {endOfInput: true});
            }
            if (newLine) return ["", "\n", "LINE_END"];
            start = characters.next();
            continue;
        } else if (start.match(/\s/)) {
            start = characters.next();
            continue;
        } else if (start.match(/[,]/)) {
            checkMatch(expected, start, "LIST_DIVIDER");
            return ["", start, "LIST_DIVIDER"];
        } else if (start.match(/[\]\)\}]/)) {
            checkMatch(expected, start, "LIST_END");
            return ["", start, "LIST_END"];
        } else if (entryKey) {
            checkMatch(expected, start, "KEY");
            return matchKey(characters, start, entryKey);
        } else if (start.match(/['"]/)) {
            checkMatch(expected, start, "VALUE");
            return matchString(characters, start);
        } else if (start.match(/[0-9.+-]/)) {
            checkMatch(expected, start, "VALUE");
            return matchNumber(characters, start);
        } else if (start.match(/[a-z_]/i)) {
            checkMatch(expected, start, "VALUE");
            return matchKeyword(characters, start);
        } else if (start.match(/[\[\(]/)) {
            checkMatch(expected, start, "VALUE");
            return matchArray(characters, start);
        } else if (start.match(/[\{]/)) {
            checkMatch(expected, start, "VALUE");
            return matchMap(characters);
        } else {
            checkMatch(expected, start, "UNKNOWN");
        }
    }
    checkMatch(expected, "", "INPUT_END");
    return ["", "", "INPUT_END"];
}


function matchKey(characters, start, level) {
    let match = matchUntil(characters, DELIMITERS, {endOfInput: true});
    if (start === "[") {
        if (level !== "FIRST_LEVEL") {
            let key = `${start}${match[0].trim()}${match[1]}`;
            let message = `key ${repr(key)} invalid `;
            message += `(repr(${"[...]"}) syntax only at first level)`;
            throw new ConfigError(message);
        }
        if (match[1] !== "]") {
            let key = `${start}${match[0].trim()}${match[1]}`;
            let message = `key ${repr(key)} invalid `;
            message += `(delimiter ${repr(match[1])} `;
            message += `reached before ${repr("]")})`;
            throw new ConfigError(message);
        }
    } else {
        match[0] = `${start}${match[0]}`.trim();
        start = "";
    }
    if (!match[0]) {
        let key = `${start}${match[1]}`;
        let message = `key ${repr(key)} invalid (blank)`;
        throw new ConfigError(message);
    }
    return [match[0], match[1], "KEY"];
}


function matchString(characters, delimiter) {
    let match = matchUntil(characters, delimiter);
    return [match[0], "", "VALUE"];
}


function matchNumber(characters, start) {
    let [raw, end] = matchUntil(characters, DELIMITERS, {endOfInput: true});
    let sign = start === "-" ? -1 : 1;
    raw = `${start === "-" || start === "+" ? "" : start}${raw}`.trim();
    if (raw.search(/[-+:/utc]/i) > -1) return matchDate(raw, end);
    raw = raw.replace(/_(\d{3})/g, "$1").replace(/ (\d{3})/g, "$1")
    if (raw.match(/^(NA|NAN|N\/A)$/i)) return [sign * NaN, end, "VALUE"];
    if (raw.match(/^(INF|INFINITY)$/i)) return [sign * Infinity, end, "VALUE"];
    let number = Number(raw);
    if (Number.isNaN(number)) throw new ConfigError(`number ${repr(raw)} invalid`);
    return [sign * number, end, "VALUE"];
}


function matchDate(raw, end) {
    let datePattern = "((?:\\d{4}-\\d{2}-\\d{2}|\\d{4}/\\d{2}/\\d{2}))";
    let timePatterm = "(\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?)";
    let offsetPattern = "(?:UTC)? *([+-] *(?:\\d{2}:\\d{2}|\\d{1,2}))";
    let pattern = `^${datePattern}((?:T| *)${timePatterm}?)? *${offsetPattern}?$`;
    let regex = new RegExp(pattern, "i");
    let match = raw.match(regex);
    if (!match) throw new ConfigError(`date ${repr(raw)} invalid`);
    let [, date, , time, , fractional, offset] = match;
    let [year, month, day] = date.split(/[-/]/g).map(Number);
    let [h = 0, min = 0, s = 0] = (time || "00:00:00").split(":").map(Number);
    if (month > 12 || day > 31 || h > 24 || min > 60 || s > 60) {
        throw new ConfigError(`date ${repr(raw)} invalid`);
    }
    let ms = Number(`0${(fractional || ".0")}`) * 1000;
    let dateObject = new Date(year, month - 1, day, h, min, s, ms);
    if (offset) {
        let [hOffset, minOffset] = offset.slice(1).split(":").map(Number);
        let msOffset = (hOffset * 60 + (minOffset || 0)) * 60 * 1000;
        if (offset[0] === "-") msOffset = -msOffset;
        dateObject = new Date(Date.UTC(year, month - 1, day, h, min, s, ms));
        dateObject.setTime(dateObject.getTime() - msOffset);
    }
    return [dateObject, end, "VALUE"];
}


function matchKeyword(characters, start) {
    let [raw, end] = matchUntil(characters, DELIMITERS, {endOfInput: true});
    raw = `${start}${raw}`.trim();
    let keyword = {
        "TRUE": true, "FALSE": false, "NULL": null,
        "INF": Infinity, "INFINITY": Infinity,
        "NA": NaN, "NAN": NaN, "N/A": NaN,
    }[raw.toUpperCase()];
    if (keyword !== undefined) return [keyword, end, "VALUE"];
    throw new ConfigError(`keyword ${repr(raw)} invalid`);
}


function matchArray(characters, delimiter) {
    delimiter = {"[": "]", "(": ")"}[delimiter];
    let result = [];
    let start = "";
    let expected = ["VALUE", "LIST_END", "LINE_END"];
    while (true) {
        let entry = matchNext(characters, {expected, start});
        if (entry[2] === "VALUE") {
            result.push(entry[0]);
            start = entry[1];
            expected = ["LIST_DIVIDER", "LIST_END", "LINE_END"];
        } else if (entry[2] === "LIST_DIVIDER") {
            start = "";
            expected = ["VALUE", "LIST_END", "LINE_END"];
        } else {
            if (entry[1] !== delimiter) {
                let message = `end of array ${repr(delimiter)} `;
                message += `expected but ${repr(entry[1])} reached`;
                throw new ConfigError(message);
            }
            break;
        }
    }
    return [result, "", "VALUE"];
}


function matchMap(characters) {
    let result = new Map();
    let start = "";
    let expected = ["KEY", "LIST_END", "LINE_END"];
    while (true) {
        let entryKey = matchNext(characters, {expected, start, entryKey: "HIGHER_LEVEL"});
        if (entryKey[2] === "LIST_DIVIDER") {
            start = "";
            expected = ["KEY", "LIST_END", "LINE_END"];
            continue;
        } else if (entryKey[2] === "LIST_END") {
            if (entryKey[1] !== "}") {
                let message = `end of map ${repr("}")} `;
                message += `expected but ${repr(entryKey[1])} reached`;
                throw new ConfigError(message);
            }
            break;
        } else if (entryKey[1] !== "=") {
            let message = `assignment character ${repr("=")} `;
            message += `expected but ${repr(entryKey[1])} reached`;
            throw new ConfigError(message);
        }
        expected = ["VALUE"];
        let entryValue = matchNext(characters, {expected});
        start = entryValue[1];
        result.set(entryKey[0], entryValue[0]);
        expected = ["LIST_DIVIDER", "LIST_END", "LINE_END"];
    }
    return [result, "", "VALUE"];
}


function matchEntries(characters) {
    let result = new Map();
    let target = result;
    let expected = ["KEY", "LINE_END", "INPUT_END"];
    while (true) {
        let entryKey = matchNext(characters, {expected, entryKey: "FIRST_LEVEL"});
        if (entryKey[2] === "INPUT_END") {
            break
        } else if (entryKey[1] === "]") {
            target = new Map();
            result.set(entryKey[0], target);
            continue;
        } else if (entryKey[1] !== "=") {
            let message = `assignment character ${repr("=")} `;
            message += `expected but ${repr(entryKey[1])} reached `;
            message += `at entry ${repr(entryKey[0])}`;
            throw new ConfigError(message);
        }
        expected = ["VALUE"];
        let entryValue;
        try {
            entryValue = matchNext(characters, {expected});
            if (entryValue[1] !== "\n") {
                expected = ["LINE_END", "INPUT_END"];
                matchNext(characters, {expected, start: entryValue[1], newLine: true});
            }
        } catch (error) {
            if (!(error instanceof ConfigError)) throw error;
            let message = `${error.message} at entry ${repr(entryKey[0])}`;
            throw new ConfigError(message);
        }
        target.set(entryKey[0], entryValue[0]);
        expected = ["KEY", "LINE_END", "INPUT_END"];
    }
    return result;
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
        throw new ConfigError(`type of input ${repr(input)} unimplemented`);
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
        throw new ConfigError(`type of input ${repr(input)} unimplemented`);
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
    if (references.has(input)) throw new ConfigError(`circular reference to ${repr(input)}`);
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
        throw new ConfigError(`type of key ${repr(key)} invalid (string expected)`);
    }
    key = key.trim();
    if (key.search(/[^a-z0-9_-]/i) > -1) {
        let expected = "(only letters, digits, _ and - expected)";
        throw new ConfigError(`invalid character in key ${repr(key)} ${expected}`);
    }
    return key;
}


function encodeMap(input, references, level) {
    if (references.has(input)) throw new ConfigError(`circular reference to ${repr(input)}`);
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
