// Whole-buffer (offline) time-stretch and pitch-shift with Signalsmith Stretch, exported through a plain
// C ABI for a module Web Worker. Built as a standalone .wasm with no JS glue by ../scripts/build.sh.
//
// Host contract (all lengths in frames, buffers are planar: channel c starts at ptr + c * len):
//   in  = sj_alloc(channels * in_len)          -> write the input channels
//   out = sj_stretch(in, channels, in_len, out_len, sample_rate, semitones, tonality_hz)
//                                              -> read channels * out_len floats, or 0 on failure
//   sj_free(in); sj_free(out);
// The stretch ratio is out_len / in_len. The output is aligned with the input (no pre-roll).

#include "signalsmith-stretch.h"

#include <cstdlib>
#include <cstring>

using Stretch = signalsmith::stretch::SignalsmithStretch<float>;

namespace {
	// Fixed seed: identical input gives identical output (and std::random_device would need WASI imports).
	constexpr long kSeed = 0x6a756963; // "juic"

	struct Planar {
		float *data;
		int length;
		float *operator[](int channel) const { return data + size_t(channel) * size_t(length); }
	};
}

extern "C" {

__attribute__((export_name("sj_abi_version")))
int sj_abi_version() {
	return 1;
}

__attribute__((export_name("sj_alloc")))
float *sj_alloc(int floats) {
	if (floats <= 0) return nullptr;
	return static_cast<float *>(std::calloc(size_t(floats), sizeof(float)));
}

__attribute__((export_name("sj_free")))
void sj_free(float *ptr) {
	std::free(ptr);
}

__attribute__((export_name("sj_stretch")))
float *sj_stretch(const float *in, int channels, int inLength, int outLength, float sampleRate,
		float semitones, float tonalityHz) {
	if (!in || channels <= 0 || inLength <= 0 || outLength <= 0 || sampleRate <= 0) return nullptr;

	Stretch stretch(kSeed);
	stretch.presetDefault(channels, sampleRate);
	stretch.setTransposeSemitones(semitones, tonalityHz > 0 ? tonalityHz / sampleRate : 0);

	// exact() needs at least one seek length of input. Short one-shots (drum hits) are zero-padded at the
	// end, stretched with the same ratio, and trimmed back.
	double ratio = double(outLength) / double(inLength);
	int seekLength = stretch.outputSeekLength(float(1 / ratio));
	int paddedIn = inLength;
	int paddedOut = outLength;
	if (inLength < seekLength) {
		paddedIn = seekLength;
		paddedOut = int(double(seekLength) * ratio + 0.5);
		if (paddedOut < outLength) paddedOut = outLength;
	}

	float *src = const_cast<float *>(in);
	float *padded = nullptr;
	if (paddedIn != inLength) {
		padded = sj_alloc(channels * paddedIn);
		if (!padded) return nullptr;
		for (int c = 0; c < channels; ++c) {
			std::memcpy(padded + size_t(c) * paddedIn, in + size_t(c) * inLength, sizeof(float) * size_t(inLength));
		}
		src = padded;
	}

	float *out = sj_alloc(channels * paddedOut);
	if (!out) {
		sj_free(padded);
		return nullptr;
	}
	bool ok = stretch.exact(Planar{src, paddedIn}, paddedIn, Planar{out, paddedOut}, paddedOut);
	sj_free(padded);
	if (!ok) {
		sj_free(out);
		return nullptr;
	}
	if (paddedOut != outLength) {
		// Compact planar channels from stride paddedOut to stride outLength (in place, front to back).
		for (int c = 1; c < channels; ++c) {
			std::memmove(out + size_t(c) * outLength, out + size_t(c) * paddedOut, sizeof(float) * size_t(outLength));
		}
	}
	return out;
}

}
