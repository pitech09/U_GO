import { createAudioPlayer } from 'expo-audio';

const incomingPlayer = createAudioPlayer(
  require('../assets/sounds/incoming-ride.wav')
);

const updatePlayer = createAudioPlayer(
  require('../assets/sounds/ride-update.wav')
);

const cancelledPlayer = createAudioPlayer(
  require('../assets/sounds/ride-cancelled.wav')
);

incomingPlayer.loop = true;
incomingPlayer.volume = 0.75;

updatePlayer.volume = 0.65;
cancelledPlayer.volume = 0.7;

let incomingStartPending = false;

export async function startIncomingRideAlert(): Promise<void> {
  if (incomingPlayer.playing || incomingStartPending) return;

  incomingStartPending = true;

  try {
    if (incomingPlayer.isLoaded) {
      await incomingPlayer.seekTo(0);
    }
    incomingPlayer.play();
  } catch (error) {
    console.warn('Could not play incoming ride sound:', error);
  } finally {
    incomingStartPending = false;
  }
}

export async function stopIncomingRideAlert(): Promise<void> {
  try {
    incomingPlayer.pause();

    if (incomingPlayer.isLoaded) {
      await incomingPlayer.seekTo(0);
    }
  } catch (error) {
    console.warn('Could not stop incoming ride sound:', error);
  }
}

export async function playRideUpdateSound(type: string): Promise<void> {
  const player = type === 'ride_cancelled'
    ? cancelledPlayer
    : updatePlayer;

  try {
    player.pause();

    if (player.isLoaded) {
      await player.seekTo(0);
    }

    player.play();
  } catch (error) {
    console.warn('Could not play ride update sound:', error);
  }
}
