package android.graphics;
/** Host coordinate seam used by Android PDFBox's own affine/text positioning. */
public class PointF {
    public float x, y;
    public PointF() {}
    public PointF(float x, float y) { this.x = x; this.y = y; }
    public void set(float x, float y) { this.x = x; this.y = y; }
    public void set(PointF point) { set(point.x, point.y); }
    public void offset(float dx, float dy) { x += dx; y += dy; }
}
