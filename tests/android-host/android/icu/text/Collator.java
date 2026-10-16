package android.icu.text;

/** Host seam for the Android framework ICU API; Android uses its own ICU, not this class. */
public final class Collator {
    private final com.ibm.icu.text.Collator actual;
    private Collator(java.util.Locale locale){actual=com.ibm.icu.text.Collator.getInstance(locale);}
    public static Collator getInstance(java.util.Locale locale){return new Collator(locale);}
    public int compare(String first,String second){return actual.compare(first,second);}
}
