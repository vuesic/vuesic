import { createGain } from '@/lib/audio/gain';
import { dbToGain, gainToDb } from '@/lib/audio/conversions';
import { ObeoParam } from '@/lib/audio/param';
import { ObeoNode } from '@/lib/audio/node';

export interface ObeoVolumeNode extends ObeoNode<GainNode> {
  readonly volume: ObeoParam;
  mute: (value: boolean) => void;
}

export const createVolume = (): ObeoVolumeNode => {
  const gain = createGain({ toUnit: gainToDb, fromUnit: dbToGain });
  return {
    ...gain,
    volume: gain.gain,
  };
};
