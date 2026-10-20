// Brand kit: logos, colours and fonts shared by every project (stored in the app settings).
import { emit } from './store.js';

export const brand = { logos: [], colors: [], fontTitle: '', fontBody: '' };

export async function loadBrand() {
  Object.assign(brand, await window.native.brandGet());
  emit('brand');
}

export async function saveBrand() {
  await window.native.brandSet(brand);
  emit('brand');
}
