import './styles.css';
import { pb } from './pocketbase';

function render(root: HTMLElement) {
  root.textContent = 'Talked Down';
}

const root = document.querySelector('#app');
if (root instanceof HTMLElement) {
  render(root);
}

void pb;
