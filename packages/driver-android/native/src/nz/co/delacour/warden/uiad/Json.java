package nz.co.delacour.warden.uiad;

/**
 * Tiny JSON writing helpers. Output is ASCII only (everything above 0x7e is a \\uXXXX escape) so the wire
 * survives any shell or pty encoding in between; requests are parsed with org.json, which ships with Android.
 */
final class Json {
	private Json() {}

	/** Append `s` as a JSON string literal. */
	static void str(StringBuilder sb, CharSequence s) {
		sb.append('"');
		for (int i = 0, n = s.length(); i < n; i++) {
			char c = s.charAt(i);
			switch (c) {
				case '"':
					sb.append("\\\"");
					break;
				case '\\':
					sb.append("\\\\");
					break;
				case '\n':
					sb.append("\\n");
					break;
				case '\r':
					sb.append("\\r");
					break;
				case '\t':
					sb.append("\\t");
					break;
				default:
					if (c < 0x20 || c > 0x7e) {
						sb.append("\\u");
						String hex = Integer.toHexString(c);
						for (int pad = hex.length(); pad < 4; pad++) sb.append('0');
						sb.append(hex);
					} else {
						sb.append(c);
					}
			}
		}
		sb.append('"');
	}

	/** Append `"key":"value"` with a leading comma when `first` is false; null values are skipped. */
	static boolean field(StringBuilder sb, boolean first, String key, CharSequence value) {
		if (value == null || value.length() == 0) return first;
		if (!first) sb.append(',');
		str(sb, key);
		sb.append(':');
		str(sb, value);
		return false;
	}

	/** Append `"key":true` (only when set; absent means false). */
	static boolean flag(StringBuilder sb, boolean first, String key, boolean on) {
		if (!on) return first;
		if (!first) sb.append(',');
		str(sb, key);
		sb.append(":true");
		return false;
	}
}
