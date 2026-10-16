package cn.readage.app;

import android.graphics.Rect;
import android.view.ActionMode;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import java.util.concurrent.atomic.AtomicBoolean;

/** Callback contract checks only; no Chromium, OEM toolbar, or device UI simulation. */
public final class ReadageSelectionActionModeCallbackHostTest {
    private static int passed;

    public static void main(String[] args) {
        createClearsAfterDelegation();
        prepareClearsRepopulatedMenu();
        falsePolicyKeepsOriginalMenu();
        rejectedCreateKeepsOriginalResult();
        prepareKeepsOriginalChangedResult();
        itemAndDestroyAreDelegated();
        contentRectUsesOriginalCallback2();
        contentRectFallsBackToDefault();
        System.out.println("PASS: " + passed + " Android selection callback host cases");
    }

    private static void createClearsAfterDelegation() {
        RecordingCallback original = new RecordingCallback();
        original.createItems = 4;
        TestMenu menu = new TestMenu();
        TestMode mode = new TestMode();
        ReadageSelectionActionModeCallback callback = new ReadageSelectionActionModeCallback(original, () -> true);
        check(callback.onCreateActionMode(mode, menu), "create must preserve original true");
        check(original.createCount == 1 && original.lastMode == mode && original.lastMenu == menu, "create must delegate original arguments once");
        check(menu.size() == 0 && menu.clearCount == 1, "create must clear items added by original");
        check(mode.finishCount == 0, "create must retain selection action mode");
        passed++;
    }

    private static void prepareClearsRepopulatedMenu() {
        RecordingCallback original = new RecordingCallback();
        original.createItems = 3;
        original.prepareItems = 2;
        original.prepareResult = false;
        TestMenu menu = new TestMenu();
        TestMode mode = new TestMode();
        ReadageSelectionActionModeCallback callback = new ReadageSelectionActionModeCallback(original, () -> true);
        callback.onCreateActionMode(mode, menu);
        for (int preparation = 1; preparation <= 2; preparation++) {
            menu.items = 1; // An OEM/WebView may add another command between callbacks.
            check(callback.onPrepareActionMode(mode, menu), "clearing a restored menu must report a change");
            check(menu.size() == 0 && menu.clearCount == preparation + 1, "prepare must clear every restored menu");
        }
        check(original.prepareCount == 2 && original.lastMenu == menu, "prepare must delegate every time");
        original.prepareItems = 0;
        check(!callback.onPrepareActionMode(mode, menu), "empty unchanged menu must remain unchanged");
        check(mode.finishCount == 0, "prepare must retain handles and selection action mode");
        passed++;
    }

    private static void falsePolicyKeepsOriginalMenu() {
        RecordingCallback original = new RecordingCallback();
        original.createItems = 2;
        original.prepareItems = 1;
        TestMenu menu = new TestMenu();
        TestMode mode = new TestMode();
        AtomicBoolean suppress = new AtomicBoolean(false);
        ReadageSelectionActionModeCallback callback = new ReadageSelectionActionModeCallback(original, suppress::get);
        check(callback.onCreateActionMode(mode, menu) && menu.size() == 2, "editable/non-reader create menu must stay available");
        check(!callback.onPrepareActionMode(mode, menu) && menu.size() == 3, "editable/non-reader prepare must preserve original result and menu");
        check(menu.clearCount == 0, "false policy must never clear menu");
        suppress.set(true);
        check(callback.onPrepareActionMode(mode, menu) && menu.size() == 0, "policy must be evaluated again when reader selection becomes active");
        suppress.set(false);
        check(!callback.onPrepareActionMode(mode, menu) && menu.size() == 1, "returning to editable/non-reader selection must retain commands");
        check(mode.finishCount == 0, "policy changes must not finish action mode");
        passed++;
    }

    private static void rejectedCreateKeepsOriginalResult() {
        RecordingCallback original = new RecordingCallback();
        original.createResult = false;
        original.createItems = 2;
        TestMenu menu = new TestMenu();
        TestMode mode = new TestMode();
        ReadageSelectionActionModeCallback callback = new ReadageSelectionActionModeCallback(original, () -> true);
        check(!callback.onCreateActionMode(mode, menu), "original rejection must stay false");
        check(menu.size() == 2 && menu.clearCount == 0, "rejected action mode must not clear menu");
        check(original.createCount == 1 && mode.finishCount == 0, "rejected action mode delegates once without explicit finish");
        passed++;
    }

    private static void prepareKeepsOriginalChangedResult() {
        RecordingCallback original = new RecordingCallback();
        original.prepareResult = true;
        TestMenu menu = new TestMenu();
        TestMode mode = new TestMode();
        ReadageSelectionActionModeCallback callback = new ReadageSelectionActionModeCallback(original, () -> true);
        check(callback.onPrepareActionMode(mode, menu), "empty menu must preserve original changed=true");
        original.prepareResult = false;
        menu.items = 1;
        check(callback.onPrepareActionMode(mode, menu), "cleared nonempty menu must report changed=true");
        check(menu.size() == 0 && mode.finishCount == 0, "prepare must clear without finishing");
        passed++;
    }

    private static void itemAndDestroyAreDelegated() {
        RecordingCallback original = new RecordingCallback();
        TestMode mode = new TestMode();
        MenuItem item = new MenuItem() {};
        ReadageSelectionActionModeCallback callback = new ReadageSelectionActionModeCallback(original, () -> true);
        original.itemResult = true;
        check(callback.onActionItemClicked(mode, item), "item true result must be preserved");
        original.itemResult = false;
        check(!callback.onActionItemClicked(mode, item), "item false result must be preserved");
        check(original.itemCount == 2 && original.lastMode == mode && original.lastItem == item, "item callback must receive original arguments");
        callback.onDestroyActionMode(mode);
        check(original.destroyCount == 1 && original.lastMode == mode, "destroy callback must be delegated once");
        check(mode.finishCount == 0, "delegation must not explicitly finish action mode");
        passed++;
    }

    private static void contentRectUsesOriginalCallback2() {
        RectCallback original = new RectCallback();
        TestMode mode = new TestMode();
        View view = new View(100, 200);
        Rect rect = new Rect();
        ReadageSelectionActionModeCallback callback = new ReadageSelectionActionModeCallback(original, () -> true);
        callback.onGetContentRect(mode, view, rect);
        check(original.rectCount == 1 && original.lastMode == mode && original.lastView == view && original.lastRect == rect, "Callback2 must receive original content rect arguments");
        check(rect.left == 5 && rect.top == 6 && rect.right == 25 && rect.bottom == 36, "original content rect must survive wrapper");
        check(mode.finishCount == 0, "content rect must not finish action mode");
        passed++;
    }

    private static void contentRectFallsBackToDefault() {
        TestMode mode = new TestMode();
        View view = new View(91, 132);
        Rect rect = new Rect();
        rect.set(-1, -2, -3, -4);
        ReadageSelectionActionModeCallback callback = new ReadageSelectionActionModeCallback(new RecordingCallback(), () -> true);
        callback.onGetContentRect(mode, view, rect);
        check(rect.left == 0 && rect.top == 0 && rect.right == 91 && rect.bottom == 132, "Callback1 must use default view content rect");
        check(mode.finishCount == 0, "default content rect must not finish action mode");
        passed++;
    }

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    private static final class TestMenu implements Menu {
        int items;
        int clearCount;
        @Override public int size() { return items; }
        @Override public void clear() { items = 0; clearCount++; }
    }

    private static final class TestMode extends ActionMode {
        int finishCount;
        @Override public void finish() { finishCount++; }
    }

    private static class RecordingCallback implements ActionMode.Callback {
        boolean createResult = true;
        boolean prepareResult;
        boolean itemResult;
        int createItems;
        int prepareItems;
        int createCount;
        int prepareCount;
        int itemCount;
        int destroyCount;
        ActionMode lastMode;
        Menu lastMenu;
        MenuItem lastItem;

        @Override public boolean onCreateActionMode(ActionMode mode, Menu menu) {
            createCount++;
            lastMode = mode;
            lastMenu = menu;
            ((TestMenu) menu).items += createItems;
            return createResult;
        }
        @Override public boolean onPrepareActionMode(ActionMode mode, Menu menu) {
            prepareCount++;
            lastMode = mode;
            lastMenu = menu;
            ((TestMenu) menu).items += prepareItems;
            return prepareResult;
        }
        @Override public boolean onActionItemClicked(ActionMode mode, MenuItem item) {
            itemCount++;
            lastMode = mode;
            lastItem = item;
            return itemResult;
        }
        @Override public void onDestroyActionMode(ActionMode mode) {
            destroyCount++;
            lastMode = mode;
        }
    }

    private static final class RectCallback extends ActionMode.Callback2 {
        int rectCount;
        ActionMode lastMode;
        View lastView;
        Rect lastRect;
        @Override public boolean onCreateActionMode(ActionMode mode, Menu menu) { return true; }
        @Override public boolean onPrepareActionMode(ActionMode mode, Menu menu) { return false; }
        @Override public boolean onActionItemClicked(ActionMode mode, MenuItem item) { return false; }
        @Override public void onDestroyActionMode(ActionMode mode) {}
        @Override public void onGetContentRect(ActionMode mode, View view, Rect outRect) {
            rectCount++;
            lastMode = mode;
            lastView = view;
            lastRect = outRect;
            outRect.set(5, 6, 25, 36);
        }
    }
}
