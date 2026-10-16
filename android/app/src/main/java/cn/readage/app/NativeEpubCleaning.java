package cn.readage.app;

import java.text.Normalizer;
import java.util.*;
import java.util.regex.Pattern;

/** The existing Node magazine cutoff/furniture policy; never applied to personal short chapters. */
final class NativeEpubCleaning {
    private static final Pattern TITLE=Pattern.compile("^(cover|contents|table of contents|copyright|title page|masthead|colophon|advertisement|subscribe|credits|index)$",Pattern.CASE_INSENSITIVE);
    private static final Pattern ATTRIBUTION=Pattern.compile("^(?:Read:\\s+|This (?:article|poem) (?:appears|was featured|was downloaded)\\b)",Pattern.CASE_INSENSITIVE);
    // Java's default \s is ASCII; use the ECMAScript whitespace set used by Node.
    private static final String SPACE="[\\s\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+";
    static String clean(String value){return value.replaceAll(SPACE," ").trim();}
    static int wordCount(String value){String trimmed=clean(value);return trimmed.isEmpty()?0:trimmed.split(" ").length;}
    static boolean skipTitle(String title){return TITLE.matcher(clean(title)).matches();}
    static boolean furniture(String value) {
        String trimmed=clean(value);if(ATTRIBUTION.matcher(trimmed).find() || trimmed.matches("[\\s\\-_=*.:·•—–]{8,}"))return true;
        String normalized=Normalizer.normalize(trimmed,Normalizer.Form.NFKC).replaceAll("[^\\p{L}\\p{N}]+"," ").trim().toLowerCase(Locale.ROOT);if(normalized.isEmpty())return false;
        String[] tokens=normalized.split(" ");int index=0,labels=0;
        while(index<tokens.length){String token=tokens[index];if(token.equals("next")||token.equals("previous"))index++;else if((token.equals("section")||token.equals("main"))&&index+1<tokens.length&&tokens[index+1].equals("menu"))index+=2;else return false;labels++;}return labels>=2;
    }
    static boolean readable(String title,List<String> paragraphs){return !skipTitle(title)&&wordCount(String.join(" ",paragraphs))>=80&&paragraphs.stream().anyMatch(value->!furniture(value)&&wordCount(value)>0);}
}
