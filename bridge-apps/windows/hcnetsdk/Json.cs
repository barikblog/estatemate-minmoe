// A minimal JSON reader and writer for the helper's stdio protocol.
//
// Written by hand on purpose: the helper must build on any Windows machine with
// the C# compiler that ships in the .NET Framework directory, and on Linux/macOS
// with a plain `dotnet build`. No NuGet package, no System.Web.Extensions, no
// dependency that can fail to resolve on a customer's gate PC.
//
// It handles exactly what the protocol uses — objects, arrays, strings, numbers,
// booleans and null — and refuses anything else loudly rather than guessing.
// Written in C# 5.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace EstateMate.HikSdk
{
    internal static class Json
    {
        // ------------------------------------------------------------- writing ---

        internal static string Write(object value)
        {
            StringBuilder builder = new StringBuilder();
            WriteValue(builder, value);
            return builder.ToString();
        }

        private static void WriteValue(StringBuilder builder, object value)
        {
            if (value == null) { builder.Append("null"); return; }
            if (value is string) { WriteString(builder, (string)value); return; }
            if (value is bool) { builder.Append(((bool)value) ? "true" : "false"); return; }
            if (value is int || value is long || value is uint || value is short || value is byte)
            {
                builder.Append(Convert.ToInt64(value, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture));
                return;
            }
            if (value is double || value is float || value is decimal)
            {
                builder.Append(Convert.ToDouble(value, CultureInfo.InvariantCulture).ToString("R", CultureInfo.InvariantCulture));
                return;
            }
            IDictionary<string, object> map = value as IDictionary<string, object>;
            if (map != null)
            {
                builder.Append('{');
                bool first = true;
                foreach (KeyValuePair<string, object> pair in map)
                {
                    if (!first) builder.Append(',');
                    first = false;
                    WriteString(builder, pair.Key);
                    builder.Append(':');
                    WriteValue(builder, pair.Value);
                }
                builder.Append('}');
                return;
            }
            System.Collections.IEnumerable list = value as System.Collections.IEnumerable;
            if (list != null)
            {
                builder.Append('[');
                bool first = true;
                foreach (object item in list)
                {
                    if (!first) builder.Append(',');
                    first = false;
                    WriteValue(builder, item);
                }
                builder.Append(']');
                return;
            }
            WriteString(builder, Convert.ToString(value, CultureInfo.InvariantCulture));
        }

        private static void WriteString(StringBuilder builder, string value)
        {
            builder.Append('"');
            foreach (char c in value)
            {
                switch (c)
                {
                    case '"': builder.Append("\\\""); break;
                    case '\\': builder.Append("\\\\"); break;
                    case '\n': builder.Append("\\n"); break;
                    case '\r': builder.Append("\\r"); break;
                    case '\t': builder.Append("\\t"); break;
                    default:
                        if (c < 0x20) builder.Append("\\u").Append(((int)c).ToString("x4"));
                        else builder.Append(c);
                        break;
                }
            }
            builder.Append('"');
        }

        // ------------------------------------------------------------- reading ---

        internal static Dictionary<string, object> ParseObject(string text)
        {
            int index = 0;
            object value = ParseValue(text, ref index);
            SkipWhitespace(text, ref index);
            if (index < text.Length) throw new FormatException("trailing characters after the JSON object");
            Dictionary<string, object> map = value as Dictionary<string, object>;
            if (map == null) throw new FormatException("the request was not a JSON object");
            return map;
        }

        private static object ParseValue(string text, ref int index)
        {
            SkipWhitespace(text, ref index);
            if (index >= text.Length) throw new FormatException("unexpected end of input");
            char c = text[index];
            switch (c)
            {
                case '{': return ParseMap(text, ref index);
                case '[': return ParseArray(text, ref index);
                case '"': return ParseString(text, ref index);
                case 't': Expect(text, ref index, "true"); return true;
                case 'f': Expect(text, ref index, "false"); return false;
                case 'n': Expect(text, ref index, "null"); return null;
                default: return ParseNumber(text, ref index);
            }
        }

        private static Dictionary<string, object> ParseMap(string text, ref int index)
        {
            Dictionary<string, object> map = new Dictionary<string, object>();
            index++; // {
            SkipWhitespace(text, ref index);
            if (index < text.Length && text[index] == '}') { index++; return map; }
            while (true)
            {
                SkipWhitespace(text, ref index);
                if (index >= text.Length || text[index] != '"') throw new FormatException("a key was expected");
                string key = ParseString(text, ref index);
                SkipWhitespace(text, ref index);
                if (index >= text.Length || text[index] != ':') throw new FormatException("a ':' was expected after " + key);
                index++;
                map[key] = ParseValue(text, ref index);
                SkipWhitespace(text, ref index);
                if (index >= text.Length) throw new FormatException("the object was not closed");
                if (text[index] == ',') { index++; continue; }
                if (text[index] == '}') { index++; return map; }
                throw new FormatException("a ',' or '}' was expected");
            }
        }

        private static List<object> ParseArray(string text, ref int index)
        {
            List<object> list = new List<object>();
            index++; // [
            SkipWhitespace(text, ref index);
            if (index < text.Length && text[index] == ']') { index++; return list; }
            while (true)
            {
                list.Add(ParseValue(text, ref index));
                SkipWhitespace(text, ref index);
                if (index >= text.Length) throw new FormatException("the array was not closed");
                if (text[index] == ',') { index++; continue; }
                if (text[index] == ']') { index++; return list; }
                throw new FormatException("a ',' or ']' was expected");
            }
        }

        private static string ParseString(string text, ref int index)
        {
            StringBuilder builder = new StringBuilder();
            index++; // "
            while (index < text.Length)
            {
                char c = text[index++];
                if (c == '"') return builder.ToString();
                if (c != '\\') { builder.Append(c); continue; }
                if (index >= text.Length) break;
                char escape = text[index++];
                switch (escape)
                {
                    case '"': builder.Append('"'); break;
                    case '\\': builder.Append('\\'); break;
                    case '/': builder.Append('/'); break;
                    case 'b': builder.Append('\b'); break;
                    case 'f': builder.Append('\f'); break;
                    case 'n': builder.Append('\n'); break;
                    case 'r': builder.Append('\r'); break;
                    case 't': builder.Append('\t'); break;
                    case 'u':
                        if (index + 4 > text.Length) throw new FormatException("a truncated \\u escape");
                        builder.Append((char)int.Parse(text.Substring(index, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                        index += 4;
                        break;
                    default: throw new FormatException("an unknown escape \\" + escape);
                }
            }
            throw new FormatException("the string was not closed");
        }

        private static object ParseNumber(string text, ref int index)
        {
            int start = index;
            while (index < text.Length && "-+.eE0123456789".IndexOf(text[index]) >= 0) index++;
            string slice = text.Substring(start, index - start);
            if (slice.Length == 0) throw new FormatException("a value was expected at position " + start);
            long integer;
            if (long.TryParse(slice, NumberStyles.Integer, CultureInfo.InvariantCulture, out integer)) return integer;
            double real;
            if (double.TryParse(slice, NumberStyles.Float, CultureInfo.InvariantCulture, out real)) return real;
            throw new FormatException("'" + slice + "' is not a number");
        }

        private static void Expect(string text, ref int index, string literal)
        {
            if (index + literal.Length > text.Length || text.Substring(index, literal.Length) != literal)
            {
                throw new FormatException("'" + literal + "' was expected");
            }
            index += literal.Length;
        }

        private static void SkipWhitespace(string text, ref int index)
        {
            while (index < text.Length && (text[index] == ' ' || text[index] == '\t' || text[index] == '\r' || text[index] == '\n')) index++;
        }

        // ------------------------------------------------------------- helpers ---

        internal static string AsString(object value)
        {
            if (value == null) return null;
            string text = value as string;
            if (text != null) return text;
            return Convert.ToString(value, CultureInfo.InvariantCulture);
        }

        internal static long AsLong(object value)
        {
            if (value == null) return 0;
            if (value is long) return (long)value;
            if (value is int) return (int)value;
            if (value is double) return (long)(double)value;
            long parsed;
            if (long.TryParse(Convert.ToString(value, CultureInfo.InvariantCulture), NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed)) return parsed;
            return 0;
        }
    }
}
