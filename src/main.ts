import './style.css';
import { createScene } from './scene';
import { setupHotspots } from './editor';
import { setupAboutLink } from './about';
import { setupLoadingOverlay } from './loading-overlay';

const canvas = document.getElementById('application-canvas') as HTMLCanvasElement;
window.focus();

const loading = setupLoadingOverlay();
setupAboutLink();
const scene = await createScene(canvas);
loading.hide();
await setupHotspots(scene);
