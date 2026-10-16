package android.view;

import android.graphics.Rect;

public abstract class ActionMode {
    public abstract void finish();

    public interface Callback {
        boolean onCreateActionMode(ActionMode mode, Menu menu);
        boolean onPrepareActionMode(ActionMode mode, Menu menu);
        boolean onActionItemClicked(ActionMode mode, MenuItem item);
        void onDestroyActionMode(ActionMode mode);
    }

    public abstract static class Callback2 implements Callback {
        public void onGetContentRect(ActionMode mode, View view, Rect outRect) {
            outRect.set(0, 0, view.getWidth(), view.getHeight());
        }
    }
}
