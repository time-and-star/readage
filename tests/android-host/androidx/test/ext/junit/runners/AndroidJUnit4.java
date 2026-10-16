package androidx.test.ext.junit.runners;
import org.junit.runners.BlockJUnit4ClassRunner;
import org.junit.runners.model.InitializationError;
public class AndroidJUnit4 extends BlockJUnit4ClassRunner { public AndroidJUnit4(Class<?> type) throws InitializationError { super(type); } }
