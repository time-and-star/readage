package android.view;

public final class View {
    private final int width;
    private final int height;

    public View(int width, int height) {
        this.width = width;
        this.height = height;
    }

    public int getWidth() { return width; }
    public int getHeight() { return height; }
}
