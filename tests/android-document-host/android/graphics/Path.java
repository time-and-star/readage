package android.graphics;
import java.awt.geom.*;
/** Host clipping path backed by real AWT geometry. This does not emulate Android rasterisation. */
public class Path {
    public enum Op { DIFFERENCE, INTERSECT, UNION, XOR, REVERSE_DIFFERENCE }
    public enum FillType { WINDING, EVEN_ODD, INVERSE_WINDING, INVERSE_EVEN_ODD }
    private Path2D.Float path = new Path2D.Float();
    public Path() {}
    public Path(Path source) { path = (Path2D.Float) source.path.clone(); }
    public void moveTo(float x, float y) { path.moveTo(x, y); }
    public void lineTo(float x, float y) { path.lineTo(x, y); }
    public void quadTo(float x1, float y1, float x2, float y2) { path.quadTo(x1, y1, x2, y2); }
    public void cubicTo(float x1, float y1, float x2, float y2, float x3, float y3) { path.curveTo(x1, y1, x2, y2, x3, y3); }
    public void close() { path.closePath(); }
    public void reset() { path.reset(); }
    public void rewind() { reset(); }
    public boolean isEmpty() { return path.getCurrentPoint() == null; }
    public void setFillType(FillType fill) { path.setWindingRule(fill == FillType.EVEN_ODD ? Path2D.WIND_EVEN_ODD : Path2D.WIND_NON_ZERO); }
    public void addPath(Path other) { path.append(other.path, false); }
    public void computeBounds(RectF bounds, boolean exact) {
        Rectangle2D rectangle = path.getBounds2D();
        bounds.set((float) rectangle.getMinX(), (float) rectangle.getMinY(), (float) rectangle.getMaxX(), (float) rectangle.getMaxY());
    }
    public boolean op(Path other, Op operation) {
        Area area = new Area(path), operand = new Area(other.path);
        switch (operation) {
            case DIFFERENCE: area.subtract(operand); break;
            case INTERSECT: area.intersect(operand); break;
            case UNION: area.add(operand); break;
            case XOR: area.exclusiveOr(operand); break;
            case REVERSE_DIFFERENCE: operand.subtract(area); area = operand; break;
        }
        path = new Path2D.Float(area); return true;
    }
}
