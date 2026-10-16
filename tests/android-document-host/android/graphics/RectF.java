package android.graphics;
/** Host rectangle seam with actual bounds arithmetic. */
public class RectF {
    public float left, top, right, bottom;
    public RectF() {}
    public RectF(float left, float top, float right, float bottom) { set(left, top, right, bottom); }
    public RectF(RectF source) { this(source.left, source.top, source.right, source.bottom); }
    public void set(float left, float top, float right, float bottom) { this.left = left; this.top = top; this.right = right; this.bottom = bottom; }
    public void set(RectF source) { set(source.left, source.top, source.right, source.bottom); }
    public float width() { return right - left; }
    public float height() { return bottom - top; }
    public boolean contains(float x, float y) { return left < right && top < bottom && x >= left && x < right && y >= top && y < bottom; }
}
