import * as t from '@/lib/io';
import * as oly from '@/lib/olyger';
import uuid from 'uuid';
import {
  SynthType,
  SoundfontType,
  Soundfont,
  Synth,
  PatternType,
  Score,
  Pattern,
  Instrument,
  Sample,
  SampleType,
  PlaylistType,
  AutomationClip,
  AutomationType,
  TrackType,
  Channel,
  Track,
  ChannelType,
  createAutomationPrototype,
  createPatternPrototype,
  createSamplePrototype,
  Playlist,
  PlaylistElementLookup,
  PlaylistElementType,
  Automatable,
  ClipContext,
  PlaylistElements,
} from '@/models';
import Tone from 'tone';
import * as Audio from '@/lib/audio';
import { makeLookup, reverse, range } from '@/lib/std';
import fs from '@/lib/fs';
import { loadBufferSync } from '@/lib/wav';
import { notify } from '@/core/notify';
import { getLogger } from '@/lib/log';
import tmp from 'tmp';
import { GraphNode, masterNode } from '@/lib/audio/node';
import * as framework from '@/lib/framework';
import { remote } from 'electron';
import { emitter, addEventListener } from '@/lib/events';
import { createExtension } from '@/lib/framework';
import { commands } from '@/core/commands';
import { computed } from '@vue/composition-api';

const logger = getLogger('project');

const DG = 'dg';
const FILTERS = [{ name: 'DAWG Files', extensions: [DG] }];
const DG_EXTENSION = `.${DG}`;

// Chaining Examples
// If I delete an instrument, I need to delete the scores
// If I delete a pattern, I need to delete the pattern elements
// If I delete a sample, I need to delete the sample elements
// If I delete an automation clip, I need to delete the automation clip elements

// Chaining Principles
// 1. I only need to worry about my action (ie. how to execute AND undo my action)
// 2. Chains define dependencies and work off a simple API (ie. changed, added, removed)
// 3. Any chain reactions will be encompassed into a single action (ie. only a single undo/redo for the whole chain)

export const ProjectType = t.type({
  id: t.string,
  stepsPerBeat: t.number,
  beatsPerMeasure: t.number,
  bpm: t.number,
  name: t.string,
  instruments: t.array(t.union([SynthType, SoundfontType])),
  patterns: t.array(PatternType),
  samples: t.array(SampleType),
  master: PlaylistType,
  automationClips: t.array(AutomationType),
  channels: t.array(ChannelType),
  tracks: t.array(TrackType),
});

export type IProject = t.TypeOf<typeof ProjectType>;

interface LoadedProject {
  bpm: number;
  stepsPerBeat: number;
  beatsPerMeasure: number;
  name: string;
  id: string;
  patterns: oly.OlyArr<Pattern>;
  instruments: oly.OlyArr<Synth | Soundfont>;
  channels: oly.OlyArr<Channel>;
  tracks: oly.OlyArr<Track>;
  master: Playlist;
  samples: oly.OlyArr<Sample>;
  automationClips: oly.OlyArr<AutomationClip>;
}

export interface InitializationError {
  type: 'error';
  message: string;
  project: LoadedProject;
}

export interface InitializationSuccess {
  type: 'success';
  project: LoadedProject;
}

const load = (iProject: IProject): InitializationSuccess | InitializationError => {
  // FIXME what happens when we can add and delete channels?
  // What should be the chain reaction?
  const channels =  oly.olyArr(iProject.channels.map((iChannel) => {
    return new Channel(iChannel);
  }), 'Channel');

  const instruments = oly.olyArr(iProject.instruments.map((iInstrument) => {
    switch (iInstrument.instrument) {
      case 'soundfont':
        return new Soundfont(new Audio.Soundfont(iInstrument.soundfont), iInstrument);
      case 'synth':
        return new Synth(iInstrument);
    }
  }), 'Instrument');

  const instrumentLookup = makeLookup(instruments);
  const channelLookup = makeLookup(channels);
  const tracks = oly.olyArr(iProject.tracks.map((iTrack) => new Track(iTrack)), 'Track');

  // First, check that all the IDs exist in the lookup
  for (const iPattern of iProject.patterns) {
    for (const iScore of iPattern.scores) {
      if (!(iScore.instrumentId in instrumentLookup)) {
        return {
          type: 'error',
          message: `Instrument from score ${iScore.id} was not found in instrument list.`,
          project: emptyProject(),
        };
      }
    }
  }

  const patterns = oly.olyArr(iProject.patterns.map((iPattern) => {
    const transport = new Audio.Transport();

    // Then create the scores now that we know the instruments all exist
    const scores = iPattern.scores.map((iScore) => {
      return new Score(transport, instrumentLookup[iScore.instrumentId], iScore);
    });

    return new Pattern(iPattern, transport, scores);
  }), 'Pattern');

  const notFound: string[] = [];
  const samples = oly.olyArr(iProject.samples.map((iSample) => {
    let buffer: AudioBuffer | null = null;
    if (fs.existsSync(iSample.path)) {
      buffer = loadBufferSync(iSample.path);
    } else {
      notFound.push(iSample.path);
    }

    return new Sample(buffer, iSample);
  }), 'Sample');

  if (notFound.length !== 0) {
    notify.warning(`Audio files not found`, {
      detail: `${notFound.join('\n')}`,
    });
  }

  const automationClips = oly.olyArr(iProject.automationClips.map((iAutomationClip) => {
    let signal: Audio.Signal;
    if (iAutomationClip.context === 'channel') {
      // FIXME remove this
      signal = (channelLookup[iAutomationClip.contextId] as any)[iAutomationClip.attr];
    } else {
      signal = (instrumentLookup[iAutomationClip.contextId] as any)[iAutomationClip.attr];
    }

    if (!signal) {
      // FIXME remove this error and instead return error
      throw Error('Unable to parse automation clip');
    }

    return new AutomationClip(signal, iAutomationClip);
  }), 'Automation Clip');

  const clipLookup = makeLookup(automationClips);
  const patternLookup = makeLookup(patterns);
  const sampleLookup = makeLookup(samples);

  const mTransport = new Audio.Transport(); // master transport
  const elements: PlaylistElements[] = [];
  for (const iElement of iProject.master.elements) {
    switch (iElement.type) {
      case 'automation':
        if (!(iElement.id in clipLookup)) {
          return {
            type: 'error',
            message: `An Automation clip from the Playlist was not found (${iElement.id}).`,
            project: emptyProject(),
          };
        }

        const clip = clipLookup[iElement.id];
        elements.push(createAutomationPrototype(iElement, clip, {})(mTransport).copy());
        break;
      case 'pattern':
        if (!(iElement.id in patternLookup)) {
          return {
            type: 'error',
            message: `A Pattern from the Playlist was not found (${iElement.id}).`,
            project: emptyProject(),
          };
        }

        const pattern = patternLookup[iElement.id];
        elements.push(createPatternPrototype(iElement, pattern, {})(mTransport).copy());
        break;
      case 'sample':
        if (!(iElement.id in sampleLookup)) {
          return {
            type: 'error',
            message: `A sample from the Playlist was not found (${iElement.id}).`,
            project: emptyProject(),
          };
        }

        const sample = sampleLookup[iElement.id];
        elements.push(createSamplePrototype(iElement, sample, {})(mTransport).copy());
        break;
    }
  }

  const master = new Playlist(mTransport, elements);

  return {
    type: 'success',
    project: {
      bpm: iProject.bpm,
      stepsPerBeat: iProject.stepsPerBeat,
      beatsPerMeasure: iProject.beatsPerMeasure,
      name: iProject.name,
      id: iProject.id,
      patterns,
      instruments,
      channels,
      tracks,
      master,
      samples,
      automationClips,
    },
  };
};

function emptyProject(): LoadedProject {
  return {
    id: uuid.v4(),
    bpm: 120,
    stepsPerBeat: 4,
    beatsPerMeasure: 4,
    name: '',
    master: new Playlist(new Audio.Transport(), []),
    patterns: oly.olyArr([Pattern.create('Pattern 0')], 'Pattern'),
    instruments: oly.olyArr([Synth.create('Synth 0')], 'Instrument'),
    channels: oly.olyArr(range(10).map((index) => Channel.create(index)), 'Channel'),
    tracks: oly.olyArr(range(21).map((index) => Track.create(index)), 'Track'),
    samples: oly.olyArr([], 'Sample'),
    automationClips: oly.olyArr([], 'Automation Clip'),
  };
}

function loadProject(): InitializationError | InitializationSuccess {
  logger.debug('Initiate loading of the project!');

  const projectJSON = framework.manager.getProjectJSON();

  if (!projectJSON) {
    return {
      type: 'success',
      project: emptyProject(),
    };
  }

  const result = t.decodeItem(ProjectType, projectJSON);
  if (result.type === 'error') {
    return {
      type: 'error',
      message: result.message,
      project: emptyProject(),
    };
  }

  return load(result.decoded);
}

export const defineAPI = (i: LoadedProject) => {
  const {
    master,
    patterns,
    instruments,
    channels,
    tracks,
    samples,
    automationClips,
  } = i;

  const mutedTracks = computed(() => {
    // 1. Get the track and the index in a tuple
    // 2. Filter to only the muted tracks
    // 3. Map so that you only have the indices
    // 4. Create a set with the indices
    return new Set(tracks
      .map((tr, ind) => [tr, ind] as const)
      .filter(([tr]) => tr.mute.value)
      .map(([_, ind]) => ind),
    );
  });

  // Ok this this solution kinda works but isn't complete
  // I honestly don't know how to go about fixing this issue but here is a description:
  // When a track is unmuted, everything in that track needs to be checked for onMidStart, onTick, and onEnd
  // Right now, we do nothing so for e.g. if a sample is halfway finish in a muted track which is subsequently
  // unmuted then we don't trigger the onMidStart or onEnd events
  // IMO this isn't a very simple problem to solve because the transport which handles all playback doesn't
  // have the concept on a track so how do we tell it to check all previous events which were previously filtered
  // out?? This isn't a huge issue though so I'm not fixing it ATM
  master.transport.addFilter((event) => {
    return !mutedTracks.value.has(event.row);
  });

  instruments.onDidRemove(({ items: deletedInstruments }) => {
    logger.debug('instruments onDidRemove with ' + deletedInstruments.length + ' elements!');
    const instrumentSet = new Set<Instrument>(deletedInstruments);

    patterns.forEach((pattern) => {
      const toRemove: number[] = [];
      pattern.scores.forEach((score, ind) => {
        if (instrumentSet.has(score.instrument)) {
          toRemove.push(ind);
        }
      });

      logger.debug(`Removing ${toRemove.length} scores from "${pattern.name}"`);
      for (const ind of reverse(toRemove)) {
        pattern.scores.splice(ind, 1);
      }
    });
  });

  // FIXME move to instrument?? This is kinda tough though as the instruments would need references
  // to the channels.
  const setChannel = (instrument: Soundfont | Synth, channel: number | undefined) => {
    let destination: GraphNode;
    const destinationName = channel !== undefined ? `Channel ${channel}` : 'Master';
    if (channel === undefined) {
      destination = masterNode;
    } else {
      const c = channels[channel];
      destination = c.effects[0]?.effect ?? c.input;
    }

    return {
      execute: () => {
        logger.debug(`Connecting "${instrument.name.value}" to ${destinationName}`);
        const dispose = instrument.output.connect(destination);
        return {
          undo: () => {
            logger.debug(`Undoing connecting of "${instrument.name.value}" to ${destinationName}`);
            dispose.dispose();
          },
        };
      },
    };
  };

  const watchInstruments = ({ items }: { items: Array<Soundfont | Synth> }) => {
    items.forEach((instrument) => {
      instrument.channel.onDidChange(({ newValue: channel, subscriptions }) => {
        subscriptions.push(setChannel(instrument, channel));
      });
    });
  };

  instruments.onDidAdd(watchInstruments);

  // Do the initial connection
  instruments.forEach((instrument) => setChannel(instrument, instrument.channel.value).execute());
  watchInstruments({ items: instruments });

  const removeElements = <T extends PlaylistElementType>(
    type: T,
    removed: Array<PlaylistElementLookup[T]['element']>,
  ) => {
    const set = new Set(removed);
    const toRemove: number[] = [];
    master.elements.forEach((el, ind) => {
      if (el.type === type && set.has(el.element)) {
        toRemove.push(ind);
      }
    });

    for (const ind of reverse(toRemove)) {
      master.elements.splice(ind, 1);
    }
  };

  samples.onDidRemove(({ items: removedSamples }) => {
    removeElements('sample', removedSamples);
  });

  patterns.onDidRemove(({ items: removedPatterns }) => {
    removeElements('pattern', removedPatterns);
  });

  automationClips.onDidRemove(({ items: removedAutomation }) => {
    removeElements('automation', removedAutomation);
  });

  const serialize = (): IProject => {
    return {
      id: project.id,
      bpm: project.bpm.value,
      name: project.name.value,
      stepsPerBeat: project.stepsPerBeat,
      beatsPerMeasure: project.beatsPerMeasure,
      patterns: patterns.map((pattern) => pattern.serialize()),
      instruments: instruments.map((instrument) => instrument.serialize()),
      channels: channels.map((channel) => channel.serialize()),
      tracks: tracks.map((track) => track.serialize()),
      samples: samples.map((sample) => sample.serialize()),
      automationClips: automationClips.map((clip) => clip.serialize()),
      master: master.serialize(),
    };
  };

  async function save(path: string) {
    const encoded = serialize();
    await fs.writeFile(path, JSON.stringify(encoded, null, 4));
  }

  // FIXME move this somewhere else
  function createAutomationClip<T extends Automatable>(
    payload: { automatable: T, key: keyof T & string, end: number, start: number },
  ) {
    const { start, end, key, automatable } = payload;
    const signal = automatable[key] as any as Audio.Signal;

    const available: boolean[] = Array(tracks.length).fill(true);
    master.elements.forEach((element) => {
      if (
        start > element.time.value && start < element.time.value + element.duration.value ||
        end > element.time.value && end < element.time.value + element.duration.value
      ) {
        available[element.row.value] = false;
      }
    });

    let row: number | null = null;
    for (const [ind, isAvailable] of available.entries()) {
      if (isAvailable) {
        row = ind;
        break;
      }
    }

    if (row === null) {
      notify.warning('Unable to create automation clip', {
        detail: 'There are no free tracks. Move elements and try again.',
      });

      return;
    }

    let context: ClipContext;
    if (automatable instanceof Channel) {
      context = 'channel';
    } else {
      context = 'instrument';
    }

    const length = payload.end - payload.start;
    const clip = AutomationClip.create(length, signal, context, automatable.id, key);
    const placed = createAutomationPrototype(
      { time: payload.start, row, duration: clip.duration },
      clip,
      {},
    )(master.transport).copy();
    automationClips.push(clip);
    master.elements.push(placed);
  }

  async function openTempProject(p: IProject) {
    const { name: path } = tmp.fileSync({ keep: true });
    await fs.writeFile(path, JSON.stringify(p, null, 4));

    logger.info(`Writing ${path} as backup`);
    framework.manager.setOpenedFile(path, { isTemp: true });

    const window = remote.getCurrentWindow();
    window.reload();
  }

  const events = emitter<{ save: [IProject] }>();
  function onDidSave(cb: (encoded: IProject) => void) {
    events.addListener('save', cb);
    return {
      dispose() {
        events.removeListener('save', cb);
      },
    };
  }

  async function saveProject(opts: { forceDialog?: boolean }) {
    let projectPath = framework.manager.getOpenedFile();

    if (!projectPath || opts.forceDialog) {
      const saveDialogReturn = await remote.dialog.showSaveDialog(remote.getCurrentWindow(), {});
      projectPath = saveDialogReturn.filePath || null;


      // If the user cancels the dialog
      if (!projectPath) {
        return;
      }

      if (!projectPath.endsWith(DG_EXTENSION)) {
        logger.info(`Adding ${DG_EXTENSION} to project path`);
        projectPath = projectPath + DG_EXTENSION;
      }

      // Make sure we set the cache and the general
      // The cache is what is written to the filesystem
      // and the general is the file that is currently opened
      logger.info(`Setting opened project as ${projectPath}`);
      framework.manager.setOpenedFile(projectPath);
    }

    const encoded = serialize();
    await fs.writeFile(projectPath, JSON.stringify(encoded, null, 4));
    events.emit('save', encoded);
    oly.freezeReference();
  }

  async function removeOpenedFile() {
    await framework.manager.setOpenedFile();
  }

  async function setOpenedFile(path: string) {
    await framework.manager.setOpenedFile(path);
  }

  function getOpenedFile() {
    return framework.manager.getOpenedFile();
  }

  Audio.Context.BPM = i.bpm;
  const bpm = oly.olyRef(i.bpm, 'BPM');
  bpm.onDidChange(({ newValue, oldValue, subscriptions }) => {
    subscriptions.push({
      execute: () => {
        Audio.Context.BPM = newValue;
        return {
          undo: () => {
            Audio.Context.BPM = oldValue;
          },
        };
      },
    });
  });

  logger.info('Master node -> ', masterNode);

  return {
    id: i.id,
    bpm,
    name: oly.olyRef(i.name),
    stepsPerBeat: i.stepsPerBeat,
    beatsPerMeasure: i.beatsPerMeasure,
    instruments,
    patterns,
    serialize,
    master,
    samples,
    automationClips,
    tracks,
    channels,
    save,
    createAutomationClip,
    openTempProject,
    onDidSave,
    onDidSetOpenedFile: framework.manager.onDidSetOpenedFile,
    saveProject,
    removeOpenedFile,
    setOpenedFile,
    getOpenedFile,
  } as const;
};

const extension = createExtension({
  id: 'dawg.project',
  activate(context) {
    const result = loadProject();
    if (result.type === 'error') {
      notify.warning('Unable to load project.', { detail: result.message, duration: Infinity });
    }

    const api = defineAPI(result.project);

    context.subscriptions.push(addEventListener('online', () => {
      api.instruments.forEach((instrument) => {
        instrument.online();
      });
    }));

    const save = framework.defineMenuBarItem({
      menu: 'File',
      section: '1_save',
      text: 'Save',
      shortcut: ['CmdOrCtrl', 'S'],
      callback: async () => {
        logger.debug('"Save" initiated!');
        await api.saveProject({
          forceDialog: false,
        });
      },
    });

    const saveAs = framework.defineMenuBarItem({
      menu: 'File',
      section: '1_save',
      text: 'Save As',
      shortcut: ['CmdOrCtrl', 'Shift', 'S'],
      callback: async () => {
        logger.debug('"Save As" initiated!');
        await api.saveProject({
          forceDialog: true,
        });
      },
    });

    const open = framework.defineMenuBarItem({
      menu: 'File',
      section: '0_newOpen',
      text: 'Open',
      shortcut: ['CmdOrCtrl', 'O'],
      callback: async () => {
        // files can be undefined. There is an issue with the .d.ts files.
        const files = await remote.dialog.showOpenDialog(
          remote.getCurrentWindow(),
          { filters: FILTERS, properties: ['openFile'] },
        );


        if (!files.filePaths || files.filePaths.length === 0) {
          return;
        }

        const filePath = files.filePaths[0];
        await api.setOpenedFile(filePath);

        const window = remote.getCurrentWindow();
        window.reload();
      },
    });

    const newProject = framework.defineMenuBarItem({
      menu: 'File',
      section: '0_newOpen',
      shortcut: ['CmdOrCtrl', 'N'],
      text: 'New Project',
      callback: async () => {
        await api.removeOpenedFile();

        const window = remote.getCurrentWindow();
        window.reload();
      },
    });

    const undo = framework.defineMenuBarItem({
      menu: 'Edit',
      section: '0_undoRedo',
      shortcut: ['CmdOrCtrl', 'Z'],
      text: 'Undo',
      callback: () => {
        oly.undo();
      },
    });

    const redo = framework.defineMenuBarItem({
      menu: 'Edit',
      section: '0_undoRedo',
      shortcut: ['CmdOrCtrl', 'Shift', 'Z'],
      text: 'Redo',
      callback: () => {
        oly.redo();
      },
    });

    [save, saveAs, open, newProject].map((command) => {
      context.subscriptions.push(commands.registerCommand({ ...command, registerAccelerator: false }));
      context.subscriptions.push(framework.addToMenu(command));
    });

    ([undo, redo]).map((command) => {
      context.subscriptions.push(commands.registerCommand({ ...command, registerAccelerator: false }));
      context.subscriptions.push(framework.addToMenu(command));
    });

    context.settings.push({
      type: 'string',
      label: 'Project Name',
      description: 'Give your project a better name to make it more identifiable.',
      value: api.name,
    });

    return api;
  },
});

export const project = framework.manager.activate(extension);

// tslint:disable-next-line:no-console
console.log(project);
