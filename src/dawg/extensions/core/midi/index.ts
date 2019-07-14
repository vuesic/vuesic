import webmidi, { WebMidiEventConnected, WebMidiEventDisconnected, InputEventNoteon, InputEventNoteoff } from 'webmidi';
import { Extension } from '@/dawg/extensions';
import { notify } from '@/dawg/extensions/core/notify';
import { instruments } from '@/dawg/extensions/core/instruments';
import { keyLookup } from '@/utils';
import { patterns } from '@/dawg/extensions/core/patterns';
import { Note } from '@/core';
import * as Audio from '@/modules/audio';
import { theme } from '@/dawg/extensions/core/theme';
import { pianoRoll } from '@/dawg/extensions/core/piano-roll';
import { value, computed, watch } from 'vue-function-api';
import { project } from '../project';

export const extension: Extension = {
  id: 'dawg.midi',
  activate() {
    const selectedScore = instruments.selectedScore;
    const recordedNotes: {[key: string]: InputEventNoteon} = {};
    const notesStartTimes: {[key: string]: number} = {};
    let transport = new Audio.Transport(); // TODO REMOVE THIS

    const recording = value(false);

    const onDidNoteOn = (e: InputEventNoteon) => {
      if (recording.value) {
        recordedNotes[e.note.name + e.note.octave] = e;
        const transportLocation = transport.progress * (transport.loopEnd - transport.loopStart);
        notesStartTimes[e.note.name + e.note.octave] = transportLocation / 60  * project.project.bpm;
      }

      if (selectedScore.value) {
        selectedScore.value.instrument.triggerAttack(e.note.name + e.note.octave, e.rawVelocity);
      }
    };

    const onDidNoteOff = (e: InputEventNoteoff) => {
      if (selectedScore.value) {
        selectedScore.value.instrument.triggerRelease(e.note.name + e.note.octave);
      }

      if (!recording.value) {
        return;
      }

      const noteOn = recordedNotes[e.note.name + e.note.octave];
      delete recordedNotes[e.note.name + e.note.octave];

      const noteStartTime = notesStartTimes[e.note.name + e.note.octave];
      delete notesStartTimes[e.note.name + e.note.octave];
      const noteDuration = e.timestamp - noteOn.timestamp;

      if (selectedScore.value) {
        const note = new Note(selectedScore.value.instrument, {
          row: keyLookup[e.note.name + e.note.octave].id,
          duration: noteDuration / 1000 / 60 * project.project.bpm,
          time: noteStartTime,
          velocity: noteOn.rawVelocity,
        });

        selectedScore.value.notes.push(note);

        if (patterns.selectedPattern.value) {
          note.schedule(transport);
        }
      }
    };

    const onDidConnected = (event: WebMidiEventConnected) => {
      if (event.port.type !== 'input') {
        return;
      }

      const input = event.port;
      if (!input) {
        return;
      }

      notify.success('MIDI Input Detected', {
        detail: `${event.port.name} is now connected to Vusic.`,
      });

      input.addListener('noteon', 'all', onDidNoteOn);
      input.addListener('noteoff', 'all', onDidNoteOff);
    };

    const onDidDisconnected = (event: WebMidiEventDisconnected) => {
      if (event.port.type === 'input') {
        notify.warning('MIDI Input Diconnected', {
          detail: `${event.port.name} has been disconnected.`,
        });
      }
    };

    const afterEnable = () => {
      webmidi.addListener('connected', onDidConnected);
      webmidi.addListener('disconnected', onDidDisconnected);
    };

    webmidi.enable(afterEnable);

    function startRecording() {
      if (!instruments.selectedScore.value) {
        notify.warning('No Score Found', {
          detail: 'Please create a score before you start recording',
        });
        return;
      }

      recording.value = !recording.value;

      if (patterns.selectedPattern.value) {
        transport = patterns.selectedPattern.value.transport;
        transport.start();
        project.startTransport();
      }
    }

    function stopRecording() {
      recording.value = !recording.value;
      project.stopTransport();
    }

    const props = {
      color: theme.foreground,
      size: '14px',
    };

    watch(recording, () => {
      props.color = recording.value ? theme.error : theme.foreground;
    });

    pianoRoll.addAction({
      icon: value('fiber_manual_record'),
      tooltip: computed(() => recording.value ? 'Stop Recording' : 'Start Recording'),
      callback: () => {
        if (recording.value) {
          stopRecording();
        } else {
          startRecording();
        }
      },
      props,
    });
  },

  deactivate() {
    const input = webmidi.inputs[0];

    if (input) {
      input.removeListener();
    }
  },
};