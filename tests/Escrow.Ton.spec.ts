import { Blockchain, printTransactionFees, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, SendMode, toNano } from '@ton/core';
import { Escrow } from '../wrappers/Escrow';
import '@ton/test-utils';

const SECONDS = 1000;
jest.setTimeout(70 * SECONDS);

describe('Escrow Ton Tests', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;

    let seller: SandboxContract<TreasuryContract>;
    let buyer: SandboxContract<TreasuryContract>;
    let guarantor: SandboxContract<TreasuryContract>;
    let lastCtxId = 1n;

    const generateEscrowContract = async (assetAddress: Address | null, dealAmount: bigint, royalty: bigint) => {
        return blockchain.openContract(
            await Escrow.fromInit(
                lastCtxId++,
                seller.address,
                guarantor.address,
                dealAmount,
                royalty,
                assetAddress,
                null,
            ),
        );
    };

    beforeEach(async () => {
        blockchain = await Blockchain.create();

        deployer = await blockchain.treasury('deployer');
        seller = await blockchain.treasury('seller');
        buyer = await blockchain.treasury('buyer');
        guarantor = await blockchain.treasury('guarantor');
    });

    // ton tests
    it('should deploy with correct state ton flow', async () => {
        const escrowContract = await generateEscrowContract(null, 100n, 1n);

        const deployResult = await escrowContract.send(
            deployer.getSender(),
            {
                value: toNano('0.05'),
            },
            {
                $$type: 'Deploy',
                queryId: 0n,
            },
        );

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: escrowContract.address,
            deploy: true,
            success: true,
        });

        const data = await escrowContract.getEscrowInfo();

        expect(data.assetAddress).toBeNull();
        expect(data.dealAmount).toBe(100n);
        expect(data.guarantorRoyaltyPercent).toBe(1n);
        expect(data.guarantorAddress).toEqualAddress(guarantor.address);
        expect(data.sellerAddress).toEqualAddress(seller.address);
        expect(data.jettonWalletCode).toBeNull();
        expect(data.buyerAddress).toBeNull();
    });

    it('should accept correct ton funding', async () => {
        const dealAmount = toNano(1); // 1 ton

        const escrowContract = await generateEscrowContract(null, dealAmount, 1n);

        await escrowContract.send(
            deployer.getSender(),
            {
                value: toNano('0.05'),
            },
            {
                $$type: 'Deploy',
                queryId: 0n,
            },
        );

        const fundingResult = await escrowContract.send(
            buyer.getSender(),
            {
                value: dealAmount,
            },
            'funding',
        );

        expect(fundingResult.transactions).toHaveTransaction({
            from: buyer.address,
            to: escrowContract.address,
            value: dealAmount,
            success: true,
        });

        const data = await escrowContract.getEscrowInfo();

        expect(data.buyerAddress).toEqualAddress(buyer.address);
        expect(data.isFunded).toBeTruthy();
    });

    it('should reject wrong ton amount', async () => {
        const dealAmount = toNano(1); // 1 ton

        const escrowContract = await generateEscrowContract(null, dealAmount, 1n);

        await escrowContract.send(
            deployer.getSender(),
            {
                value: toNano('0.05'),
            },
            {
                $$type: 'Deploy',
                queryId: 0n,
            },
        );

        const maliciousFundingResult = await escrowContract.send(
            buyer.getSender(),
            {
                value: dealAmount - 1n,
            },
            'funding',
        );

        expect(maliciousFundingResult.transactions).toHaveTransaction({
            from: buyer.address,
            to: escrowContract.address,
            value: dealAmount - 1n,
            success: false,
            exitCode: 15301, // wrong fund amount
        });

        const data = await escrowContract.getEscrowInfo();

        expect(data.buyerAddress).toBeNull();
        expect(data.isFunded).toBeFalsy();
    });

    it('should reject double funding ton', async () => {
        const dealAmount = toNano(1); // 1 ton

        const escrowContract = await generateEscrowContract(null, dealAmount, 1n);

        await escrowContract.send(
            deployer.getSender(),
            {
                value: toNano('0.05'),
            },
            {
                $$type: 'Deploy',
                queryId: 0n,
            },
        );

        // succesfully funded
        await escrowContract.send(
            buyer.getSender(),
            {
                value: dealAmount,
            },
            'funding',
        );

        const secondFundingResult = await escrowContract.send(
            buyer.getSender(),
            {
                value: dealAmount,
            },
            'funding',
        );

        expect(secondFundingResult.transactions).toHaveTransaction({
            from: buyer.address,
            to: escrowContract.address,
            value: dealAmount,
            success: false,
            exitCode: 33704, // already funded
        });
    });

    it('should correctly calculate guarantor royalties', async () => {
        const dealAmount = toNano(10); // 10 ton
        const guarantorRoyaltyPercent = 5_000n; // 5%

        const escrowContract = await generateEscrowContract(null, dealAmount, guarantorRoyaltyPercent);

        await escrowContract.send(
            deployer.getSender(),
            {
                value: toNano('0.05'),
            },
            {
                $$type: 'Deploy',
                queryId: 0n,
            },
        );

        const guarantorRoyalty = (dealAmount * guarantorRoyaltyPercent) / 100_000n;

        const royalty = await escrowContract.getCalculateRoyaltyAmount();

        expect(royalty).toBe(guarantorRoyalty);
        expect(royalty).toBe(toNano(0.5)); // 10 * 5% = 0.5
    });

    it('should reject code update within ton escrow', async () => {
        const dealAmount = toNano(5); // 5 ton

        const escrowContract = await generateEscrowContract(null, dealAmount, 1n);

        await escrowContract.send(
            deployer.getSender(),
            {
                value: toNano('0.05'),
            },
            {
                $$type: 'Deploy',
                queryId: 0n,
            },
        );

        const newJwalletCode = beginCell().storeAddress(seller.address).endCell();

        const updateResult = await escrowContract.send(
            seller.getSender(),
            {
                value: toNano('0.05'),
            },
            {
                $$type: 'UpdateJettonWalletCode',
                newJettonWalletCode: newJwalletCode, // example cell
            },
        );

        expect(updateResult.transactions).toHaveTransaction({
            from: seller.address,
            to: escrowContract.address,
            success: false,
            exitCode: 52368, // wrong asset type
        });
    });

    it('should reject guarantor-only actions from non-guarantor', async () => {
        const dealAmount = toNano(1); // 1 ton

        const escrowContract = await generateEscrowContract(null, dealAmount, 1n);

        await escrowContract.send(
            deployer.getSender(),
            {
                value: toNano('0.05'),
            },
            {
                $$type: 'Deploy',
                queryId: 0n,
            },
        );

        await escrowContract.send(
            buyer.getSender(),
            {
                value: dealAmount,
            },
            'funding',
        );

        const maliciousCancelResult = await escrowContract.send(
            seller.getSender(),
            {
                value: toNano('0.05'),
            },
            'cancel',
        );

        expect(maliciousCancelResult.transactions).toHaveTransaction({
            from: seller.address,
            to: escrowContract.address,
            success: false,
            exitCode: 21150, // not guarantor
        });

        const maliciousApproveResult = await escrowContract.send(
            buyer.getSender(),
            {
                value: toNano('0.05'),
            },
            'approve',
        );

        expect(maliciousApproveResult.transactions).toHaveTransaction({
            from: buyer.address,
            to: escrowContract.address,
            success: false,
            exitCode: 21150, // not guarantor
        });
    });

    it('should reject guarantor-only actions before funding', async () => {
        const dealAmount = toNano(1); // 1 ton

        const escrowContract = await generateEscrowContract(null, dealAmount, 1n);

        await escrowContract.send(
            deployer.getSender(),
            {
                value: toNano('0.05'),
            },
            {
                $$type: 'Deploy',
                queryId: 0n,
            },
        );

        const maliciousCancelResult = await escrowContract.send(
            guarantor.getSender(),
            {
                value: toNano('0.05'),
            },
            'cancel',
        );

        expect(maliciousCancelResult.transactions).toHaveTransaction({
            from: guarantor.address,
            to: escrowContract.address,
            success: false,
            exitCode: 14215, // not funded
        });

        const maliciousApproveResult = await escrowContract.send(
            guarantor.getSender(),
            {
                value: toNano('0.05'),
            },
            'approve',
        );

        expect(maliciousApproveResult.transactions).toHaveTransaction({
            from: guarantor.address,
            to: escrowContract.address,
            success: false,
            exitCode: 14215, // not funded
        });
    });

    it('should limit max royalty at the threshold', async () => {
        const dealAmount = toNano(5); // 5 ton

        // 105% royalty
        const escrowContract = await generateEscrowContract(null, dealAmount, 105000n);

        await escrowContract.send(
            deployer.getSender(),
            {
                value: toNano('0.05'),
            },
            {
                $$type: 'Deploy',
                queryId: 0n,
            },
        );

        const guarantorRoyalty = await escrowContract.getCalculateRoyaltyAmount();

        // 90% is the max royalty
        expect(guarantorRoyalty).toBe(toNano(4.5)); // 4.5 ton, 5 * 90%
    });

    it('should allow guarantor to approve the deal with ton', async () => {
        const dealAmount = toNano(1); // 1 ton

        const escrowContract = await generateEscrowContract(null, dealAmount, 1n);

        await escrowContract.send(
            deployer.getSender(),
            {
                value: toNano('0.05'),
            },
            {
                $$type: 'Deploy',
                queryId: 0n,
            },
        );

        const guaratorRoyalty = await escrowContract.getCalculateRoyaltyAmount();

        await escrowContract.send(
            buyer.getSender(),
            {
                value: dealAmount,
            },
            'funding',
        );

        const approveResult = await escrowContract.send(
            guarantor.getSender(),
            {
                value: toNano('0.05'),
            },
            'approve',
        );

        expect(approveResult.transactions).toHaveTransaction({
            from: guarantor.address,
            to: escrowContract.address,
            success: true,
            outMessagesCount: 2,
            endStatus: 'non-existing', // escrow should be destroyed after cancel
        });

        expect(approveResult.transactions).toHaveTransaction({
            from: escrowContract.address,
            to: seller.address,
            value: dealAmount - guaratorRoyalty,
            success: true,
        });

        expect(approveResult.transactions).toHaveTransaction({
            from: escrowContract.address,
            to: guarantor.address,
            value: (v) => v! >= guaratorRoyalty && v! <= guaratorRoyalty + toNano(1), // in-between check cause 128+32 send mode
            success: true,
        });
    });

    it('should keep total fees under threshold', async () => {
        const dealAmount = toNano(1); // 1 ton

        const escrowContract = await generateEscrowContract(null, dealAmount, 1n);

        await escrowContract.send(
            deployer.getSender(),
            {
                value: toNano('0.05'),
            },
            {
                $$type: 'Deploy',
                queryId: 0n,
            },
        );

        await escrowContract.send(
            buyer.getSender(),
            {
                value: dealAmount,
            },
            'funding',
        );

        const approveResult = await escrowContract.send(
            guarantor.getSender(),
            {
                value: toNano('0.05'),
            },
            'approve',
        );

        printTransactionFees(approveResult.transactions);

        for (const tx of approveResult.transactions) {
            const receiverHandledTx = tx;

            expect(receiverHandledTx.description.type).toEqual('generic');

            if (receiverHandledTx.description.type !== 'generic') {
                throw new Error('Generic transaction expected');
            }
            const computeFee =
                receiverHandledTx.description.computePhase.type === 'vm'
                    ? receiverHandledTx.description.computePhase.gasFees
                    : undefined;
            const actionFee = receiverHandledTx.description.actionPhase?.totalActionFees;

            expect((computeFee ?? 0n) + (actionFee ?? 0n)).toBeLessThanOrEqual(toNano('0.08'));
        }
    });

    it('should provide escrow data on-chain', async () => {
        const dealAmount = toNano(1); // 1 ton

        const escrowContract = await generateEscrowContract(null, dealAmount, 1n);

        await escrowContract.send(
            deployer.getSender(),
            {
                value: toNano('0.05'),
            },
            {
                $$type: 'Deploy',
                queryId: 0n,
            },
        );

        const escrowData = await escrowContract.getEscrowInfo();

        const providedDataResult = await escrowContract.send(
            buyer.getSender(),
            {
                value: dealAmount,
            },
            'provideEscrowData',
        );

        expect(providedDataResult.transactions).toHaveTransaction({
            from: buyer.address,
            to: escrowContract.address,
            success: true,
            outMessagesCount: 1,
        });

        expect(providedDataResult.transactions).toHaveTransaction({
            from: escrowContract.address,
            to: buyer.address,
            success: true,
            body: (b) => {
                let ds = b!.beginParse();
                expect(ds.loadUintBig(32)).toEqual(0x2c394a7en); // TakeEscrowData#2c394a7e

                ds = ds.loadRef().beginParse();
                expect(ds.loadUintBig(32)).toEqual(escrowData.id);
                expect(ds.loadAddress()).toEqualAddress(escrowData.sellerAddress);
                expect(ds.loadAddress()).toEqualAddress(escrowData.guarantorAddress);
                expect(ds.loadCoins()).toEqual(escrowData.dealAmount);
                expect(ds.loadUintBig(32)).toEqual(escrowData.guarantorRoyaltyPercent);
                expect(ds.loadBoolean()).toEqual(escrowData.isFunded);

                const assetAddress = ds.loadMaybeAddress();
                if (assetAddress) {
                    expect(assetAddress).toEqualAddress(escrowData.assetAddress!);
                } else {
                    expect(escrowData.assetAddress).toBeNull();
                }

                const jettonWalletCode = ds.loadMaybeRef();
                if (jettonWalletCode) {
                    expect(jettonWalletCode).toEqualCell(escrowData.jettonWalletCode!);
                } else {
                    expect(escrowData.jettonWalletCode).toBeNull();
                }

                return true;
            },
        });
    });

    it('should reject approve with low msg value', async () => {
        const dealAmount = toNano(1); // 1 ton

        const escrowContract = await generateEscrowContract(null, dealAmount, 1n);

        await escrowContract.send(
            deployer.getSender(),
            {
                value: toNano('0.05'),
            },
            {
                $$type: 'Deploy',
                queryId: 0n,
            },
        );

        await escrowContract.send(
            buyer.getSender(),
            {
                value: dealAmount,
            },
            'funding',
        );

        const approveResult = await escrowContract.send(
            guarantor.getSender(),
            {
                value: toNano('0.01'), // low value
            },
            'approve',
        );

        expect(approveResult.transactions).toHaveTransaction({
            from: guarantor.address,
            to: escrowContract.address,
            success: false,
            exitCode: 5357, // low msg value
        });
    });

    it('should allow guarantor to cancel the deal with ton', async () => {
        const dealAmount = toNano(1); // 1 ton

        const escrowContract = await generateEscrowContract(null, dealAmount, 1n);

        await escrowContract.send(
            deployer.getSender(),
            {
                value: toNano('0.05'),
            },
            {
                $$type: 'Deploy',
                queryId: 0n,
            },
        );

        await escrowContract.send(
            buyer.getSender(),
            {
                value: dealAmount,
            },
            'funding',
        );

        const cancelResult = await escrowContract.send(
            guarantor.getSender(),
            {
                value: toNano('0.05'),
            },
            'cancel',
        );

        expect(cancelResult.transactions).toHaveTransaction({
            from: guarantor.address,
            to: escrowContract.address,
            success: true,
            endStatus: 'non-existing', // escrow should be destroyed after cancel
        });

        expect(cancelResult.transactions).toHaveTransaction({
            from: escrowContract.address,
            to: buyer.address,
            value: (v) => v! >= dealAmount && v! <= dealAmount + toNano(1), // in-between check cause 128+32 send mode
            success: true,
        });
    });
});
