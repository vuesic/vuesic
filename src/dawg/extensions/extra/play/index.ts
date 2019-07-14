import Vue from 'vue';
import { createExtension } from '../..';
import * as dawg from '@/dawg';
import { createComponent, computed } from 'vue-function-api';

export const extension = createExtension({
  id: 'dawg.play',
  activate() {
    const stop = Vue.extend(createComponent({
      template: `
      <v-btn icon style="margin: 0">
        <ico fa>stop</ico>
      </v-btn>
      `,
    }));

    dawg.ui.toolbar.push({
      component: stop,
      position: 'right',
      order: 1,
    });

    const playPause = Vue.extend(createComponent({
      template: `
      <v-btn icon style="margin: 0" @click="toggle">
        <icon :name="icon" class="foreground--text"></icon>
      </v-btn>
      `,
      setup() {
        return {
          toggle: () => {
            dawg.project.playPause();
          },
          play: computed(() => {
            return dawg.project.play;
          }),
          icon: computed(() => {
            return dawg.project.play ? 'pause' : 'play';
          }),
        };
      },
    }));

    dawg.ui.toolbar.push({
      component: playPause,
      position: 'right',
      order: 2,
    });
  },
});
