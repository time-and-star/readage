package cn.readage.app;

import android.graphics.Rect;
import android.view.ActionMode;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import java.util.function.BooleanSupplier;

/** Hide only the menu: rejecting or finishing WebView's mode also clears its selection. */
class ReadageSelectionActionModeCallback extends ActionMode.Callback2 {
    private final ActionMode.Callback original;
    private final BooleanSupplier suppressMenu;

    ReadageSelectionActionModeCallback(ActionMode.Callback original, BooleanSupplier suppressMenu) {
        this.original = original;
        this.suppressMenu = suppressMenu;
    }

    private boolean clearMenu(Menu menu) {
        if (!suppressMenu.getAsBoolean()) return false;
        boolean changed = menu.size() > 0;
        menu.clear();
        return changed;
    }

    @Override public boolean onCreateActionMode(ActionMode mode, Menu menu) {
        boolean created = original.onCreateActionMode(mode, menu);
        if (created) clearMenu(menu);
        return created;
    }

    @Override public boolean onPrepareActionMode(ActionMode mode, Menu menu) {
        boolean changed = original.onPrepareActionMode(mode, menu);
        // WebView and OEM text-assist services can repopulate items after creation.
        return clearMenu(menu) || changed;
    }

    @Override public boolean onActionItemClicked(ActionMode mode, MenuItem item) {
        return original.onActionItemClicked(mode, item);
    }

    @Override public void onDestroyActionMode(ActionMode mode) {
        original.onDestroyActionMode(mode);
    }

    @Override public void onGetContentRect(ActionMode mode, View view, Rect rect) {
        if (original instanceof ActionMode.Callback2) {
            ((ActionMode.Callback2) original).onGetContentRect(mode, view, rect);
        } else {
            super.onGetContentRect(mode, view, rect);
        }
    }
}
