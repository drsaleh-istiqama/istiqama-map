function normalize(point) {
  if (point == null) return null;
  const lat = Number(point.lat), lng = Number(point.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) throw new Error('إحداثيات الموقع غير صحيحة');
  return { lat:Number(lat.toFixed(6)), lng:Number(lng.toFixed(6)) };
}

export function createMapPickSession(originalPoint) {
  const original = normalize(originalPoint);
  let selected = null;
  return {
    choose(point) { selected = normalize(point); return selected; },
    canConfirm() { return selected !== null; },
    confirm() { if (!selected) throw new Error('حدد الموقع على الخريطة أولًا'); return { ...selected }; },
    cancel() { return original ? { ...original } : null; },
    selected() { return selected ? { ...selected } : null; }
  };
}
