/*
 * Minimal JSON reader/writer for the EstateMate bridge.
 *
 * The app deliberately avoids third-party JSON dependencies: the artifact is
 * built without Gradle or Maven, so everything it needs must either ship in the
 * platform (org.json on Android) or in this source tree. Keeping the parser here
 * also means the protocol layer compiles and runs unchanged on a plain JVM,
 * which is what `scripts/build-bridge-apk.py --test` exercises.
 */
package com.estatemate.bridge;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class Json {
    private Json() {}

    public static final class JsonError extends RuntimeException {
        public JsonError(String message) {
            super(message);
        }
    }

    /** Parses a complete JSON document (object, array, string, number, bool or null). */
    public static Object parse(String text) {
        if (text == null) throw new JsonError("empty document");
        Parser parser = new Parser(text);
        Object value = parser.readValue();
        parser.skipWhitespace();
        if (!parser.atEnd()) throw new JsonError("trailing content at offset " + parser.position);
        return value;
    }

    public static Map<String, Object> parseObject(String text) {
        Object value = parse(text);
        if (!(value instanceof Map)) throw new JsonError("expected a JSON object");
        return asObject(value);
    }

    public static List<Object> parseArray(String text) {
        Object value = parse(text);
        if (!(value instanceof List)) throw new JsonError("expected a JSON array");
        return asArray(value);
    }

    /** Serialises maps, lists, strings, numbers and booleans without whitespace. */
    public static String write(Object value) {
        StringBuilder out = new StringBuilder(256);
        writeValue(out, value);
        return out.toString();
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> asObject(Object value) {
        if (value instanceof Map) return (Map<String, Object>) value;
        return new LinkedHashMap<String, Object>();
    }

    @SuppressWarnings("unchecked")
    public static List<Object> asArray(Object value) {
        if (value instanceof List) return (List<Object>) value;
        return new ArrayList<Object>();
    }

    public static Object get(Map<String, Object> object, String key) {
        if (object == null) return null;
        return object.get(key);
    }

    public static String string(Map<String, Object> object, String key, String fallback) {
        Object value = get(object, key);
        if (value == null) return fallback;
        if (value instanceof String) {
            String text = ((String) value).trim();
            return text.isEmpty() ? fallback : text;
        }
        return String.valueOf(value);
    }

    public static boolean bool(Map<String, Object> object, String key, boolean fallback) {
        Object value = get(object, key);
        if (value instanceof Boolean) return ((Boolean) value).booleanValue();
        if (value instanceof String) {
            String text = ((String) value).trim().toLowerCase();
            if (text.equals("true")) return true;
            if (text.equals("false")) return false;
        }
        return fallback;
    }

    public static int integer(Map<String, Object> object, String key, int fallback) {
        Object value = get(object, key);
        if (value instanceof Number) return (int) Math.round(((Number) value).doubleValue());
        if (value instanceof String) {
            try {
                return (int) Math.round(Double.parseDouble(((String) value).trim()));
            } catch (NumberFormatException ignored) {
                return fallback;
            }
        }
        return fallback;
    }

    private static void writeValue(StringBuilder out, Object value) {
        if (value == null) {
            out.append("null");
        } else if (value instanceof Map) {
            out.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
                if (!first) out.append(',');
                first = false;
                writeString(out, String.valueOf(entry.getKey()));
                out.append(':');
                writeValue(out, entry.getValue());
            }
            out.append('}');
        } else if (value instanceof List) {
            out.append('[');
            boolean first = true;
            for (Object item : (List<?>) value) {
                if (!first) out.append(',');
                first = false;
                writeValue(out, item);
            }
            out.append(']');
        } else if (value instanceof String) {
            writeString(out, (String) value);
        } else if (value instanceof Boolean) {
            out.append(((Boolean) value).booleanValue() ? "true" : "false");
        } else if (value instanceof Double || value instanceof Float) {
            double number = ((Number) value).doubleValue();
            if (number == Math.rint(number) && !Double.isInfinite(number)) out.append((long) number);
            else out.append(number);
        } else if (value instanceof Number) {
            out.append(((Number) value).longValue());
        } else {
            writeString(out, String.valueOf(value));
        }
    }

    private static void writeString(StringBuilder out, String text) {
        out.append('"');
        for (int i = 0; i < text.length(); i++) {
            char ch = text.charAt(i);
            switch (ch) {
                case '"':
                    out.append("\\\"");
                    break;
                case '\\':
                    out.append("\\\\");
                    break;
                case '\n':
                    out.append("\\n");
                    break;
                case '\r':
                    out.append("\\r");
                    break;
                case '\t':
                    out.append("\\t");
                    break;
                default:
                    if (ch < 0x20) out.append(String.format("\\u%04x", Integer.valueOf(ch)));
                    else out.append(ch);
            }
        }
        out.append('"');
    }

    private static final class Parser {
        private final String text;
        private int position;

        Parser(String text) {
            this.text = text;
        }

        boolean atEnd() {
            return position >= text.length();
        }

        void skipWhitespace() {
            while (position < text.length()) {
                char ch = text.charAt(position);
                if (ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r') position++;
                else break;
            }
        }

        Object readValue() {
            skipWhitespace();
            if (atEnd()) throw new JsonError("unexpected end of document");
            char ch = text.charAt(position);
            switch (ch) {
                case '{':
                    return readObject();
                case '[':
                    return readArray();
                case '"':
                    return readString();
                case 't':
                    expect("true");
                    return Boolean.TRUE;
                case 'f':
                    expect("false");
                    return Boolean.FALSE;
                case 'n':
                    expect("null");
                    return null;
                default:
                    return readNumber();
            }
        }

        private Map<String, Object> readObject() {
            Map<String, Object> object = new LinkedHashMap<String, Object>();
            position++; // '{'
            skipWhitespace();
            if (!atEnd() && text.charAt(position) == '}') {
                position++;
                return object;
            }
            for (;;) {
                skipWhitespace();
                if (atEnd() || text.charAt(position) != '"') throw new JsonError("expected a key at offset " + position);
                String key = readString();
                skipWhitespace();
                if (atEnd() || text.charAt(position) != ':') throw new JsonError("expected ':' at offset " + position);
                position++;
                object.put(key, readValue());
                skipWhitespace();
                if (atEnd()) throw new JsonError("unterminated object");
                char ch = text.charAt(position);
                if (ch == ',') {
                    position++;
                    continue;
                }
                if (ch == '}') {
                    position++;
                    return object;
                }
                throw new JsonError("expected ',' or '}' at offset " + position);
            }
        }

        private List<Object> readArray() {
            List<Object> array = new ArrayList<Object>();
            position++; // '['
            skipWhitespace();
            if (!atEnd() && text.charAt(position) == ']') {
                position++;
                return array;
            }
            for (;;) {
                array.add(readValue());
                skipWhitespace();
                if (atEnd()) throw new JsonError("unterminated array");
                char ch = text.charAt(position);
                if (ch == ',') {
                    position++;
                    continue;
                }
                if (ch == ']') {
                    position++;
                    return array;
                }
                throw new JsonError("expected ',' or ']' at offset " + position);
            }
        }

        private String readString() {
            StringBuilder out = new StringBuilder();
            position++; // opening quote
            while (position < text.length()) {
                char ch = text.charAt(position++);
                if (ch == '"') return out.toString();
                if (ch != '\\') {
                    out.append(ch);
                    continue;
                }
                if (position >= text.length()) break;
                char escape = text.charAt(position++);
                switch (escape) {
                    case '"':
                        out.append('"');
                        break;
                    case '\\':
                        out.append('\\');
                        break;
                    case '/':
                        out.append('/');
                        break;
                    case 'b':
                        out.append('\b');
                        break;
                    case 'f':
                        out.append('\f');
                        break;
                    case 'n':
                        out.append('\n');
                        break;
                    case 'r':
                        out.append('\r');
                        break;
                    case 't':
                        out.append('\t');
                        break;
                    case 'u':
                        if (position + 4 > text.length()) throw new JsonError("truncated \\u escape");
                        out.append((char) Integer.parseInt(text.substring(position, position + 4), 16));
                        position += 4;
                        break;
                    default:
                        throw new JsonError("unsupported escape \\" + escape);
                }
            }
            throw new JsonError("unterminated string");
        }

        private Object readNumber() {
            int start = position;
            while (position < text.length()) {
                char ch = text.charAt(position);
                if ((ch >= '0' && ch <= '9') || ch == '-' || ch == '+' || ch == '.' || ch == 'e' || ch == 'E') position++;
                else break;
            }
            if (start == position) throw new JsonError("unexpected character '" + text.charAt(position) + "' at offset " + position);
            try {
                return Double.valueOf(Double.parseDouble(text.substring(start, position)));
            } catch (NumberFormatException error) {
                throw new JsonError("invalid number at offset " + start);
            }
        }

        private void expect(String literal) {
            if (!text.startsWith(literal, position)) throw new JsonError("expected " + literal + " at offset " + position);
            position += literal.length();
        }
    }
}
