import path from 'path';
import { remote } from 'electron';

const { app } = remote;

export const APP_DATA = app.getPath('appData');
export const APPLICATION_PATH = path.join(APP_DATA, app.getName());

export type ApplicationContext = 'playlist' | 'pianoroll';
export type SideTab = 'Explorer' | 'Audio Files' | 'Patterns';
export type Panels = 'Piano Roll' | 'Mixer' | 'Instruments';