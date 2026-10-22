import './style.css';
import { bootstrap } from './app/bootstrap.ts';

const app = document.querySelector('.app');
if (!app) throw new Error('Application root is missing');
bootstrap(app);
